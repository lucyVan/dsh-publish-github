# dsh-publish-github

A **GitHub publishing plugin** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): type one command in the composer and publish any local directory as a GitHub repository — `git init`, repo creation, commit and push, without leaving the session.

## What it does

```
/publish <dir>   →  git init (if needed) → git add -A → commit (first commit)
                 →  origin exists → push; otherwise → gh repo create --source . --push
```

One command covers the whole flow, reporting each step as a ✓/✗ line in the session.

## Why a slash command instead of a model tool

DSH's `@deepseek-ai/*` packages live inside the Electron `app.asar`, so a plugin mounted from disk **cannot import them** — which rules out the official `ctx.tools.register` path. This plugin registers `/publish` through the host's `ctx.commands.register` instead, needing no internal package and working as soon as it is mounted.

## Install

```bash
# GitHub
dsh plugin --profile desktop add github:lucyVan/dsh-publish-github

# Local checkout
dsh plugin --profile desktop add /absolute/path/to/dsh-publish-github
```

Restart DSH afterwards. Authorize GitHub once, either way:

Install `gh` and log in (any one option):

```bash
# macOS
brew install gh

# Windows (PowerShell / winget)
winget install --id GitHub.cli

# Linux (Debian/Ubuntu)
sudo apt install gh

# Then log in (same on every platform)
gh auth login
```

Alternatively, save `GITHUB_TOKEN` in DSH credentials — the plugin injects it as `GH_TOKEN` into the `gh` child process, so gh's own login is not required.

## Usage

```
/publish /path/to/your/project
```

Options:

| Flag | Effect |
|---|---|
| `--private` | Create a private repository (public by default) |
| `--name <repo>` | Repository name (defaults to the directory basename) |
| `--message "<msg>"` | Commit message / repository description (default `Publish <repo>`) |
| `--author <name>` | Author name for the first commit (defaults to your git config) |
| `--email <addr>` | Author email for the first commit (defaults to your git config) |

Quote paths that contain spaces — Windows paths work the same way:

```
/publish "C:\Users\me\My Projects" --private
/publish "/Users/me/My Projects" --name my-project
```

Example:

```
/publish ~/IdeaProjects/my-plugin --private --name best-plugin --message "My first DSH plugin"
```

## Safety

- **Never** force-pushes, deletes branches or resets history — such words are refused up front;
- When `origin` already exists it only performs a normal `push` and never recreates the remote;
- The child environment strips `DSH_*` variables so harness configuration never reaches `gh`;
- Any directory is allowed (deliberate: the path the user names is the authorization).

## Requirements

| Dependency | Notes |
|---|---|
| `git` | required |
| `gh` | required (macOS `brew install gh` / Windows `winget install GitHub.cli` / Linux `apt install gh`) |
| GitHub auth | `gh auth login`, or a `GITHUB_TOKEN` in DSH credentials |
| Node | `>= 22` |

## Known limitations

- Only the `/publish` command; there is no settings page (account details come from gh CLI or DSH credentials);
- GitHub repositories only — no npm publishing;
- The first commit is authored as `DSH <dsh@localhost>` (amend it afterwards if you prefer);
- No conflict handling: if the remote already has unrelated history, the push fails and the error is reported verbatim.

## Compatibility

| Item | Status |
|---|---|
| DSH version | Verified on `0.2.2-rc.1`; declares `engines.dsh: >=0.2.2-rc.1 <0.3.0-0` |
| Platform | Tested on macOS; **Windows untested**, with three adaptations in place: `gh`/`gh.exe`/`gh.cmd`/`gh.bat` are probed in order, arguments honour quotes (including backslash paths), and the commit author is configurable |
| npm dependencies | **None**: only `node:*` built-ins, no `@deepseek-ai/*` imports |
| Browser module dependencies | **None**: host-only plugin, no client half |
| Required external tools | `git` and `gh`, both on `PATH` |
| Install | Declares `dsh.bundle`, so `dsh plugin add` registers it as a profile layer automatically — no manual patch editing |

Install verification: `dsh plugin --profile web add github:lucyVan/dsh-publish-github` was run in an isolated `DSH_HOME`.

## Uninstall

```bash
dsh plugin --profile desktop remove dsh-publish-github
```

Then restart DSH.

## License

MIT (see [LICENSE](LICENSE))
