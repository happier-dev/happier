# Paths, folders, and env precedence

This doc explains the **directories** that Happy Stacks uses (home/workspace/runtime/stacks), and the **environment file precedence** used by `happys`.

If you’re ever unsure what your machine is actually using, run:

```bash
happys where
```

---

## Quick glossary

- **CLI root dir**
  - The directory containing the `happy-stacks` scripts (`scripts/*.mjs`) that your `happys` command is currently executing.
  - This is *not* necessarily your current shell `cwd`.
  - It can be:
    - a cloned repo checkout (e.g. `/Users/<you>/.../happy-local`), or
    - the installed runtime package under `~/.happy-stacks/runtime/node_modules/happy-stacks` (see “Runtime dir”).

- **Home dir** (`HAPPY_STACKS_HOME_DIR`)
  - Default: `~/.happy-stacks`
  - Stores **global user config** + caches, and may include a runtime install.

- **Runtime dir** (`HAPPY_STACKS_RUNTIME_DIR`)
  - Default: `~/.happy-stacks/runtime`
  - Used by `happys self update` to install/upgrade a pinned `happy-stacks` runtime package.

- **Workspace dir** (`HAPPY_STACKS_WORKSPACE_DIR`)
  - Default: `~/.happy-stacks/workspace` (when it exists).
  - This is the **storage workspace for component repos and worktrees** used by Happy Stacks.
  - Important: this is **not your IDE workspace**; it’s where Happy Stacks keeps `components/` by default.
  - Back-compat: before you run `happys init` (cloned repo usage), we fall back to using the CLI root dir as the workspace, so `components/` lives inside the repo checkout.

- **Components dir**
  - Computed as: `<workspaceDir>/components`
  - Contains `happy`, `happy-cli`, `happy-server-light`, `happy-server`, plus `.worktrees/`.
  - Monorepo note: if `components/happy` is a `slopus/happy` monorepo checkout, `happy-cli` and `happy-server` can be derived from it (mapping to `cli/` and `server/`), even if you don’t have separate `components/happy-cli` / `components/happy-server` checkouts.
  - Monorepo worktrees are stored under `components/.worktrees/happy/...` (one repo key).

- **Stacks storage dir**
  - Default: `~/.happy/stacks`
  - Each stack lives under `~/.happy/stacks/<name>/...` and has its own env file:
    - `~/.happy/stacks/<name>/env`
  - Legacy stacks path is also supported:
    - `~/.happy/local/stacks/<name>/env`

---

## “Where am I actually running from?”

`happys` may **re-exec** to a different CLI root dir (for example, when you use an installed shim but want it to run a local checkout).

- Run `happys where` to see:
  - **rootDir** (CLI root dir)
  - **homeDir** (stacks home dir)
  - **runtimeDir**
  - **workspaceDir**
  - resolved env file paths

Tip: `happys where --json` is easier to parse.

---

## Env files + precedence (lowest → highest)

Happy Stacks loads env in `scripts/utils/env.mjs`.

### 0) “Canonical pointer” env (discovery)

If `HAPPY_STACKS_HOME_DIR` is *not* set, we first try to read the **canonical pointer** env file to discover the intended home dir (useful for LaunchAgents / SwiftBar / minimal shells).

- Default canonical pointer path: `~/.happy-stacks/.env`
- Override canonical pointer location:
  - `HAPPY_STACKS_CANONICAL_HOME_DIR=/some/dir` (pointer becomes `<dir>/.env`)

### 1) Global defaults (home config) OR cloned-repo defaults

If home config exists, we load:

- `~/.happy-stacks/.env` (**defaults**)
- `~/.happy-stacks/env.local` (**overrides**, prefix-aware for `HAPPY_STACKS_*` / `HAPPY_LOCAL_*`)

If home config does *not* exist (cloned repo usage before `happys init`), we load:

- `<cliRootDir>/.env`
- `<cliRootDir>/env.local` (prefix-aware for `HAPPY_STACKS_*` / `HAPPY_LOCAL_*`)

### 2) Repo `.env` fallback (dev convenience)

Even when home config exists, we also load:

- `<cliRootDir>/.env` (non-overriding fallback)

This exists so repo-local dev settings (example: `HAPPY_CODEX_BIN`) can work without forcing everyone to duplicate them into `~/.happy-stacks/env.local`.

Notes:
- This is a **fallback only** (`override: false`): it won’t stomp on values already provided by the environment or home config.
- We intentionally do **not** auto-load `<cliRootDir>/env.local` in this “home config exists” path, because it’s higher-precedence and can unexpectedly fight stack config.

### 3) Stack env overlay (highest precedence)

Finally, we load the active stack env file (override = true):

- `HAPPY_STACKS_ENV_FILE` (or legacy `HAPPY_LOCAL_ENV_FILE`)
- if neither is set, we auto-select the env file for the current stack (defaults to `main`) if it exists

Stack env files are allowed to contain **non-prefixed keys** (like `DATABASE_URL`) because that’s required for per-stack isolation.

---

## What should go where? (rules of thumb)

- Put **global, machine-wide defaults** in `~/.happy-stacks/.env`.
- Put **your personal overrides** in `~/.happy-stacks/env.local`.
- Put **per-stack isolation config** in the stack env file `~/.happy/stacks/<name>/env` (this is what `happys stack edit` and `happys stack wt` mutate).
- Put **repo-local dev-only defaults** in `<cliRootDir>/.env` (works best when you’re actually running from that checkout as the CLI root dir).

---

## Sandbox / test installs (fully isolated)

If you want to test the full install + setup flows without touching your real installation, run with:

```bash
npx happy-stacks --sandbox-dir /tmp/happy-stacks-sandbox where
```

In sandbox mode, Happy Stacks redirects **home/workspace/runtime/storage** under the sandbox folder (so you can `rm -rf` it to reset).

Global OS side effects (PATH edits, SwiftBar plugin install, LaunchAgents/systemd services) are **disabled by default** in sandbox mode.
To explicitly allow them for testing, set:

- `HAPPY_STACKS_SANDBOX_ALLOW_GLOBAL=1`

---

## Related docs

- `docs/stacks.md` (stacks lifecycle + commands)
- `docs/worktrees-and-forks.md` (worktrees layout + upstream/fork workflows)
