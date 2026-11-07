# dsh-publish-github

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的 **GitHub 发布插件**：在主输入框敲一条命令，把当前机器上任意目录发布成 GitHub 仓库——自动 `git init`、建仓库、提交、推送，不用离开会话。

## 它做什么

```
/publish <目录>   →   git init（如需）→ git add -A → commit（首个提交）
                  →   有 origin 就 push；没有就 gh repo create --source . --push
```

一条命令走完整个发布流程，结果以逐行 ✓/✗ 报告回显在会话里。

## 为什么是斜杠命令而不是模型工具

DSH 的 `@deepseek-ai/*` 包只存在于 Electron 的 `app.asar` 里，磁盘上的外部插件**无法 import**，因此 `ctx.tools.register` 的官方写法对外部插件不可用。本插件改用宿主 `ctx.commands.register` 注册 `/publish`，不依赖任何内部包，挂载即可生效。

## 安装

```bash
# GitHub
dsh plugin --profile desktop add github:lucyVan/dsh-publish-github

# 本地路径
dsh plugin --profile desktop add /absolute/path/to/dsh-publish-github
```

安装后**重启 DSH**。首次使用前需要 GitHub 授权，二选一：

先安装 `gh` 并登录（任选其一）：

```bash
# macOS
brew install gh

# Windows（PowerShell / winget）
winget install --id GitHub.cli

# Linux（Debian/Ubuntu）
sudo apt install gh

# 然后登录（三平台通用）
gh auth login
```

也可以不在 DSH 里存 token，改用 gh 自己的登录态。若希望由 DSH 管理凭据，在 DSH 凭据里保存 `GITHUB_TOKEN`，插件会以 `GH_TOKEN` 注入 gh 子进程。

## 使用

```
/publish /path/to/your/project
```

可选参数：

| 参数 | 作用 |
|---|---|
| `--private` | 建私有仓库（默认 public） |
| `--name <repo>` | 指定仓库名（默认取目录名） |
| `--message "<msg>"` | 提交信息 / 仓库描述（默认 `Publish <repo>`） |
| `--author <name>` | 首次提交的作者名（默认沿用 git 全局配置） |
| `--email <addr>` | 首次提交的作者邮箱（默认沿用 git 全局配置） |

路径含空格时用引号包裹，Windows 路径同样适用：

```
/publish "C:\Users\me\My Projects" --private
/publish "/Users/me/My Projects" --name my-project
```

示例：

```
/publish ~/IdeaProjects/my-plugin --private --name best-plugin --message "My first DSH plugin"
```

## 安全边界

- **永不** force push、删除分支、reset 历史——参数里出现这类词会直接被拒；
- 目录已存在 `origin` 时只做普通 `push`，不重建远程；
- 子进程环境会剥离 `DSH_*` 变量，不把 harness 自身配置透给 gh；
- 但**允许发布任意目录**（这是刻意的：用户点名的路径就是授权范围）。

## 前置条件

| 依赖 | 说明 |
|---|---|
| `git` | 必需 |
| `gh` | 必需（macOS `brew install gh` / Windows `winget install GitHub.cli` / Linux `apt install gh`） |
| GitHub 认证 | `gh auth login` 或 DSH 凭据里的 `GITHUB_TOKEN` |
| Node | `>= 22` |

## 已知限制

- 只有 `/publish` 命令，没有配套设置页（GitHub 账号信息走 gh CLI 或 DSH 凭据）；
- 不做 npm 发布，只做 GitHub 仓库；
- 首次提交的作者固定为 `DSH <dsh@localhost>`（可在提交后自行 amend）；
- 不做冲突处理：如果远程已有内容且历史不相关，push 会失败并原样报错。

## 兼容性

| 项 | 状态 |
|---|---|
| DSH 版本 | 验证于 `0.2.2-rc.1`；声明 `engines.dsh: >=0.2.2-rc.1 <0.3.0-0`，不合规环境安装期即被 DSH 拒绝 |
| 平台 | macOS 实测通过；**Windows 未实测**，但已做三处适配：命令按 `gh`/`gh.exe`/`gh.cmd`/`gh.bat` 依次探测、参数支持引号包裹（含反斜杠路径）、提交作者可配置 |
| npm 依赖 | **零依赖**：只用 `node:*` 内置模块，不 import 任何 `@deepseek-ai/*` |
| 浏览器模块依赖 | **零**：纯 host 插件，无 client 半部 |
| 必需外部工具 | `git`、`gh`（均需在 PATH 中） |
| 安装 | 带 `dsh.bundle` 声明，`dsh plugin add` 会自动登记为 profile layer，无需手工改 patch |

> **DSH 升级后装不上怎么办**：`engines.dsh` 由 DSH 强制检查，宿主版本超出窗口时安装会被拒绝（并提示可能崩溃或数据损坏）。确需在未验证版本上试跑，可用 DSH 自带的精确版本豁免：
>
> ```bash
> dsh plugin --profile <name> allow-version <包名>@<版本> --dsh-version <宿主版本> --accept-risk
> ```
>
> 试跑前请先备份工作区。本插件依赖的宿主接口（`ctx.commands.register`、右栏 tab、`agents.create` 的 seed 语义）在 rc 阶段仍可能变动。

安装验证：在隔离 `DSH_HOME` 中用 `dsh plugin --profile web add github:lucyVan/dsh-publish-github` 实测通过。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-publish-github
```

然后重启 DSH。

## 许可

MIT（见 [LICENSE](LICENSE)）
