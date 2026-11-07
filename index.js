/**
 * dsh-publish-github — host half.
 *
 * Publishes a local directory to GitHub from inside the session: it inspects
 * the directory, initialises git when needed, creates the remote repository
 * when it does not exist (or reuses `origin`), commits, and pushes.
 *
 * Entry point is a HOST slash command (`ctx.commands.register`), not a model
 * tool: external plugins cannot import `@deepseek-ai/dsh-tools` (it lives only
 * inside the Electron app.asar), so the model-tool surface is not available to
 * a plugin mounted from disk. The command path needs no internal imports.
 *
 * Authentication: a `GITHUB_TOKEN` saved through DSH's credential store is
 * injected into the `gh` child process as `GH_TOKEN`/`GITHUB_TOKEN`. When no
 * stored token exists, `gh` falls back to its own login.
 *
 * Safety: history is never rewritten. The command refuses force push, delete
 * and reset before spawning anything; everything else is allowed.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

export const name = 'publish-github'

/** Services this plugin needs from the host. */
export const inject = ['commands']

const TOKEN_ENV_KEYS = ['GITHUB_TOKEN', 'GH_TOKEN']
const DEFAULT_TIMEOUT_MS = 180_000
/** Words that make a request destructive; the command refuses them outright. */
const FORBIDDEN = /\b(force|--force|delete|reset)\b/i

/**
 * Split a command line into arguments, honouring double and single quotes so a
 * path with spaces survives intact on every platform (`"C:\\My Projects\\x"`).
 * A backslash escapes the next character inside double quotes only, which keeps
 * Windows paths like `C:\\Users\\me` intact.
 * @param {string} line - raw composer input after the command token.
 * @returns {string[]}
 */
function parseArgv(line) {
  const argv = []
  let current = ''
  let quote = null
  let started = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== null) {
      if (char === quote) {
        quote = null
      } else if (char === '\\' && quote === '"' && index + 1 < line.length
        && (line[index + 1] === '"' || line[index + 1] === '\\')) {
        // POSIX double-quote semantics: a backslash escapes only `"` and `\\`,
        // so Windows paths such as "C:\\My Projects" keep their separators.
        index += 1
        current += line[index]
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started || current !== '') {
        argv.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started || current !== '') argv.push(current)
  return argv
}

/**
 * Executable names to try for one tool, in order. Windows installations expose
 * `gh.exe`/`git.exe`, and `execFile` does not consult PATHEXT for `.cmd`/`.bat`
 * wrappers, so probe the explicit suffixes there.
 * @param {string} name - bare tool name.
 * @returns {string[]}
 */
function executableCandidates(name) {
  if (process.platform !== 'win32') return [name]
  return [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`]
}

/**
 * Run a tool, trying the platform's candidate executable names until one starts.
 * @param {string} name - bare tool name.
 * @param {string[]} args - arguments.
 * @param {{cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs?: number}} options
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function runTool(name, args, options) {
  let last = { code: 1, stdout: '', stderr: '' }
  for (const candidate of executableCandidates(name)) {
    last = await run(candidate, args, options)
    // code -1 means the executable itself could not be started; try the next name.
    if (last.code !== -1) return last
  }
  return last
}

/**
 * Run one command and capture its output.
 * @param {string} cmd - executable name.
 * @param {string[]} args - arguments.
 * @param {{cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs?: number}} options
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function run(cmd, args, options) {
  return new Promise((resolvePromise) => {
    execFile(
      cmd,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, stdout, stderr) => {
        // `-1` means the executable itself never started (ENOENT/EACCES), which
        // is what `runTool` uses to try the platform's next candidate name.
        const missing = error !== null && error !== undefined
          && (error.code === 'ENOENT' || error.code === 'EACCES')
        const raw = error === null || error === undefined ? 0 : (error.code ?? 1)
        resolvePromise({
          code: missing ? -1 : (typeof raw === 'number' ? raw : 1),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        })
      }
    )
  })
}

/** One report line. */
function line(ok, label, detail) {
  return `${ok ? '✓' : '✗'} ${label}${detail ? `: ${detail}` : ''}`
}

/** Last non-empty line of a command's error output. */
function lastLine(text) {
  return String(text ?? '').trim().split('\n').filter((entry) => entry.trim() !== '').slice(-1)[0] ?? ''
}

/** Parse package.json when present. */
async function readPackage(dir) {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Whether this directory is already a git work tree. */
async function isGitRepo(dir, env) {
  const result = await runTool('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, env })
  return result.code === 0 && result.stdout.trim() === 'true'
}

/** Whether the work tree has a committed HEAD. */
async function hasHead(dir, env) {
  const result = await runTool('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir, env })
  return result.code === 0
}

/** Branch name of HEAD, defaulting to main for an unborn branch. */
async function currentBranch(dir, env) {
  const result = await runTool('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, env })
  const value = result.stdout.trim()
  return value === '' || value === 'HEAD' ? 'main' : value
}

/** Existing `origin` URL, when one is configured. */
async function originOf(dir, env) {
  const result = await runTool('git', ['remote', 'get-url', 'origin'], { cwd: dir, env })
  return result.code === 0 ? result.stdout.trim() : undefined
}

/**
 * Build the child environment. Stored tokens win; the harness's own DSH_*
 * variables are stripped so the provider never sees them.
 * @param {string} token - saved GitHub token, possibly empty.
 * @returns {NodeJS.ProcessEnv}
 */
function buildEnv(token) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('DSH_')) delete env[key]
  }
  if (typeof token === 'string' && token !== '') {
    env.GH_TOKEN = token
    env.GITHUB_TOKEN = token
  }
  return env
}

/**
 * Resolve a stored GitHub token from the credential store, if one is saved.
 * The credential service is read defensively: a deployment without it simply
 * yields no token and `gh` uses its own login.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @returns {Promise<string>}
 */
async function storedToken(ctx) {
  let credentials
  try {
    credentials = ctx.get('credentials')
  } catch {
    return ''
  }
  if (credentials === undefined || credentials === null) return ''
  for (const key of TOKEN_ENV_KEYS) {
    try {
      const resolved = await credentials.resolve?.(key)
      const value = resolved?.value
      if (typeof value === 'string' && value !== '') return value
    } catch {
      // Try the next key.
    }
  }
  return ''
}

/**
 * Publish one directory.
 * @param {string[]} argv - parsed arguments.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @returns {Promise<{ok: boolean, text: string}>}
 */
async function publish(argv, ctx) {
  const dirArg = argv[0]
  if (typeof dirArg !== 'string' || dirArg.trim() === '') {
    return { ok: false, text: 'usage: /publish <directory> [--private] [--name <repo>] [--message <msg>] [--author <name>] [--email <addr>]' }
  }
  // Safety checks run before any filesystem or process work, so a destructive
  // request is refused no matter whether the directory exists.
  if (FORBIDDEN.test(argv.join(' '))) {
    return { ok: false, text: '✗ refusing: this command never force-pushes, deletes or resets' }
  }
  const dir = resolve(dirArg)
  if (!existsSync(dir)) return { ok: false, text: `✗ ${dir} does not exist` }

  const flags = argv.slice(1)
  const readFlag = (name) => {
    const index = flags.indexOf(name)
    return index === -1 ? undefined : flags[index + 1]
  }
  const privateRepo = flags.includes('--private')
  const message = readFlag('--message') ?? ''
  const authorName = readFlag('--author') ?? ''
  const authorEmail = readFlag('--email') ?? ''

  const repoName = String(readFlag('--name') ?? basename(dir)).trim()
  if (!/^[A-Za-z0-9._-]+$/.test(repoName)) {
    return { ok: false, text: `✗ "${repoName}" is not a valid repository name` }
  }

  const pkg = await readPackage(dir)
  const token = await storedToken(ctx)
  const env = buildEnv(token)
  const steps = [line(true, 'directory', dir)]
  if (pkg !== undefined) steps.push(line(true, 'package', typeof pkg.name === 'string' ? pkg.name : '(unnamed)'))

  if ((await runTool('gh', ['--version'], { cwd: dir, env })).code !== 0) {
    return { ok: false, text: [...steps, line(false, 'gh', 'not found — install it (https://cli.github.com) and restart DSH')].join('\n') }
  }
  if ((await runTool('git', ['--version'], { cwd: dir, env })).code !== 0) {
    return { ok: false, text: [...steps, line(false, 'git', 'not found on PATH')].join('\n') }
  }
  steps.push(line(true, 'auth', token === '' ? 'no stored GITHUB_TOKEN; using the gh login' : 'using the stored GITHUB_TOKEN'))

  if (!(await isGitRepo(dir, env))) {
    const init = await runTool('git', ['init'], { cwd: dir, env })
    steps.push(line(init.code === 0, 'git init', init.code === 0 ? '' : lastLine(init.stderr)))
    if (init.code !== 0) return { ok: false, text: steps.join('\n') }
  } else {
    steps.push(line(true, 'git', 'already a work tree'))
  }

  await runTool('git', ['add', '-A'], { cwd: dir, env })
  if (!(await hasHead(dir, env))) {
    const commitMessage = message !== '' ? message : `Publish ${repoName}`
    const commit = await run(
      'git',
      [
        ...authorName !== '' ? ['-c', `user.name=${authorName}`] : [],
        ...authorEmail !== '' ? ['-c', `user.email=${authorEmail}`] : [],
        'commit', '-m', commitMessage,
      ],
      { cwd: dir, env }
    )
    steps.push(line(commit.code === 0, 'commit', commit.code === 0 ? commitMessage : lastLine(commit.stderr)))
    if (commit.code !== 0) return { ok: false, text: steps.join('\n') }
  }

  const branch = await currentBranch(dir, env)
  const origin = await originOf(dir, env)
  if (origin !== undefined) {
    steps.push(line(true, 'remote', origin))
    const push = await runTool('git', ['push', '-u', 'origin', branch], { cwd: dir, env })
    steps.push(line(push.code === 0, `push ${branch}`, push.code === 0 ? '' : lastLine(push.stderr)))
    return { ok: push.code === 0, text: steps.join('\n') }
  }

  const create = await runTool('gh', [
    'repo', 'create', repoName,
    '--source', '.',
    '--remote', 'origin',
    '--push',
    '--description', message !== '' ? message : `Publish ${repoName}`,
    privateRepo ? '--private' : '--public',
  ], { cwd: dir, env })
  const ok = create.code === 0
  steps.push(line(ok, 'gh repo create', ok ? '' : lastLine(create.stderr) || lastLine(create.stdout)))
  if (ok) {
    const url = /https:\/\/\S+/.exec(create.stdout)
    if (url !== null) steps.push(line(true, 'repository', url[0].replace(/[.\s]+$/, '')))
  }
  return { ok, text: steps.join('\n') }
}

/**
 * Mount the host half: one `/publish` slash command.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.commands.register({
    name: 'publish',
    description: 'Publish a local directory to GitHub (git init, repo create, commit, push)',
    input: { hint: '<directory> [--private] [--name <repo>] [--message <msg>] [--author <name>] [--email <addr>]' },
    handler: async (invocation) => {
      const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput : ''
      const argv = parseArgv(raw)
      try {
        const result = await publish(argv, ctx)
        return { kind: result.ok ? 'success' : 'error', text: result.text }
      } catch (error) {
        return { kind: 'error', text: `publish failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }), 'publish-github: /publish command')
}
