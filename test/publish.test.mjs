/**
 * Behavioural checks for dsh-publish-github.
 *
 * The interesting logic is the argument parser (quotes and Windows paths), the
 * safety refusal, and the install-time contract. The git/gh calls themselves are
 * not exercised here: they need a repository and a GitHub login, and the
 * end-to-end path is covered by actually publishing a repository.
 *
 * Run with: node --test
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'index.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Compile the real `parseArgv` out of the module (it is intentionally not exported). */
function loadParseArgv() {
  const start = source.indexOf('function parseArgv(')
  const end = source.indexOf('\nfunction executableCandidates(')
  assert.ok(start !== -1 && end > start, 'parseArgv must exist in index.js')
  return new Function(`${source.slice(start, end)}; return parseArgv;`)()
}

test('module exposes the Cordis contract and needs only commands', async () => {
  const mod = await import(join(root, 'index.js'))
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['commands'])
})

test('imports only node builtins (an on-disk plugin cannot resolve @deepseek-ai/*)', () => {
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  for (const specifier of imports) {
    assert.ok(specifier.startsWith('node:'), `unexpected import: ${specifier}`)
  }
})

test('registers /publish as a host command', () => {
  assert.match(source, /ctx\.commands\.register\(\{/)
  assert.match(source, /name: 'publish'/)
  assert.match(source, /input: \{ hint:/)
})

test('argument parser keeps quoted paths with spaces intact', () => {
  const parseArgv = loadParseArgv()
  assert.deepEqual(parseArgv('/tmp/x --private'), ['/tmp/x', '--private'])
  assert.deepEqual(parseArgv('"/Users/me/My Projects" --private'), ['/Users/me/My Projects', '--private'])
  assert.deepEqual(parseArgv("'/a b/c' --name x"), ['/a b/c', '--name', 'x'])
  assert.deepEqual(parseArgv('/tmp/x    --private'), ['/tmp/x', '--private'])
  assert.deepEqual(parseArgv('   '), [])
})

test('argument parser preserves Windows paths, quoted or not', () => {
  const parseArgv = loadParseArgv()
  assert.deepEqual(parseArgv('C:\\Users\\me\\proj --private'), ['C:\\Users\\me\\proj', '--private'])
  assert.deepEqual(parseArgv('"C:\\My Projects\\app" --private'), ['C:\\My Projects\\app', '--private'])
})

test('argument parser tolerates an unterminated quote instead of dropping the tail', () => {
  const parseArgv = loadParseArgv()
  assert.deepEqual(parseArgv('/tmp/x "unclosed'), ['/tmp/x', 'unclosed'])
})

test('destructive requests are refused before any process runs', () => {
  assert.match(source, /const FORBIDDEN = /)
  assert.ok(/force|delete|reset/.test(source), 'the refusal set must cover force/delete/reset')
  const safetyIndex = source.indexOf("if (FORBIDDEN.test(argv.join(' ')))")
  const existsIndex = source.indexOf('if (!existsSync(dir))')
  assert.ok(safetyIndex !== -1 && existsIndex !== -1)
  assert.ok(safetyIndex < existsIndex, 'safety must be checked before touching the filesystem')
})

test('never force-pushes or rewrites history', () => {
  assert.ok(!/--force\b/.test(source.replace(/FORBIDDEN = .*/, '')), 'no --force anywhere')
  assert.ok(!/push', '-f'/.test(source))
  assert.ok(source.includes("'push', '-u', 'origin'"), 'pushes must be plain fast-forward pushes')
})

test('declares dsh.bundle so `dsh plugin add` installs it as a profile layer', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes(`name: '${pkg.name}'`), 'patch must insert the package name')
})

test('declares a host version window and zero dependencies', () => {
  assert.ok(pkg.engines?.dsh?.includes('<'), 'an upper bound keeps untested majors out')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
})

test('commit author is configurable rather than hardcoded', () => {
  assert.ok(source.includes("'--author'"))
  assert.ok(source.includes("'--email'"))
  assert.ok(!source.includes("'user.name=DSH'"), 'no hardcoded author identity')
})
