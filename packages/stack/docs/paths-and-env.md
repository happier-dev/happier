# Paths, folders, and env precedence

This doc explains the **directories** that Hapsta uses (home/workspace/runtime/stacks), and the **environment file precedence** used by `hapsta`.

If you’re ever unsure what your machine is actually using, run:

```bash
hapsta where
```

---

## Quick glossary

- **CLI root dir**
  - The directory containing the `@happier-dev/stack` scripts (`scripts/*.mjs`) that your `hapsta` command is currently executing.
  - This is *not* necessarily your current shell `cwd`.
  - It can be:
    - a cloned repo checkout (e.g. `/Users/<you>/.../happy-local`), or
    - the installed runtime package under `~/.happier-stack/runtime/node_modules/@happier-dev/stack` (see “Runtime dir”).

- **Home dir** (`HAPPIER_STACK_HOME_DIR`)
  - Default: `~/.happier-stack`
  - Stores **global user config** + caches, and may include a runtime install.

- **Runtime dir** (`HAPPIER_STACK_RUNTIME_DIR`)
  - Default: `~/.happier-stack/runtime`
  - Used by `hapsta self update` to install/upgrade a pinned `@happier-dev/stack` runtime package.

- **Workspace dir** (`HAPPIER_STACK_WORKSPACE_DIR`)
  - Default: `~/.happier-stack/workspace` (when it exists).
  - This is the **storage workspace for component repos and worktrees** used by Hapsta.
  - Important: this is **not your IDE workspace**; it’s where Hapsta keeps `components/` by default.
  - Before you run `hapsta init` (cloned repo usage), the CLI root dir may be used as the workspace so `components/` lives inside the repo checkout.

- **Components dir**
  - Computed as: `<workspaceDir>/components`
  - Contains `happy`, `happy-cli`, `happy-server-light`, `happy-server`, plus `.worktrees/`.
  - Monorepo note: if `components/happy` is a `slopus/happy` monorepo checkout, `happy-cli` and `happy-server` can be derived from it (mapping to `cli/` and `server/`), even if you don’t have separate `components/happy-cli` / `components/happy-server` checkouts.
  - Monorepo worktrees are stored under `components/.worktrees/happy/...` (one repo key).

- **Stacks storage dir**
  - Default: `~/.happy/stacks`
  - Each stack lives under `~/.happy/stacks/<name>/...` and has its own env file:
    - `~/.happy/stacks/<name>/env`

---

## “Where am I actually running from?”

`hapsta` may **re-exec** to a different CLI root dir (for example, when you use an installed shim but want it to run a local checkout).

- Run `hapsta where` to see:
  - **rootDir** (CLI root dir)
  - **homeDir** (stacks home dir)
  - **runtimeDir**
  - **workspaceDir**
  - resolved env file paths

Tip: `hapsta where --json` is easier to parse.

---

## Env files + precedence (lowest → highest)

Hapsta loads env in `scripts/utils/env.mjs`.

### 0) “Canonical pointer” env (discovery)

If `HAPPIER_STACK_HOME_DIR` is *not* set, we first try to read the **canonical pointer** env file to discover the intended home dir (useful for LaunchAgents / SwiftBar / minimal shells).

- Default canonical pointer path: `~/.happier-stack/.env`
- Override canonical pointer location:
  - `HAPPIER_STACK_CANONICAL_HOME_DIR=/some/dir` (pointer becomes `<dir>/.env`)

### 1) Global defaults (home config) OR cloned-repo defaults

If home config exists, we load:

- `~/.happier-stack/.env` (**defaults**)
- `~/.happier-stack/env.local` (**overrides**, prefix-aware for `HAPPIER_STACK_*`)

If home config does *not* exist (cloned repo usage before `hapsta init`), we load:

- `<cliRootDir>/.env`
- `<cliRootDir>/env.local` (prefix-aware for `HAPPIER_STACK_*`)

### 2) Repo `.env` fallback (dev convenience)

Even when home config exists, we also load:

- `<cliRootDir>/.env` (non-overriding fallback)

This exists so repo-local dev settings (example: `HAPPY_CODEX_BIN`) can work without forcing everyone to duplicate them into `~/.happier-stack/env.local`.

Notes:
- This is a **fallback only** (`override: false`): it won’t stomp on values already provided by the environment or home config.
- We intentionally do **not** auto-load `<cliRootDir>/env.local` in this “home config exists” path, because it’s higher-precedence and can unexpectedly fight stack config.

### 3) Stack env overlay (highest precedence)

Finally, we load the active stack env file (override = true):

- `HAPPIER_STACK_ENV_FILE`
- if neither is set, we auto-select the env file for the current stack (defaults to `main`) if it exists

Stack env files are allowed to contain **non-prefixed keys** (like `DATABASE_URL`) because that’s required for per-stack isolation.

---

## What should go where? (rules of thumb)

- Put **global, machine-wide defaults** in `~/.happier-stack/.env`.
- Put **your personal overrides** in `~/.happier-stack/env.local`.
- Put **per-stack isolation config** in the stack env file `~/.happy/stacks/<name>/env` (this is what `hapsta stack edit` and `hapsta stack wt` mutate).
- Put **repo-local dev-only defaults** in `<cliRootDir>/.env` (works best when you’re actually running from that checkout as the CLI root dir).

---

## Sandbox / test installs (fully isolated)

If you want to test the full install + setup flows without touching your real installation, run with:

```bash
npx @happier-dev/stack@latest --sandbox-dir /tmp/hapsta-sandbox where
```

In sandbox mode, Hapsta redirects **home/workspace/runtime/storage** under the sandbox folder (so you can `rm -rf` it to reset).

Global OS side effects (PATH edits, SwiftBar plugin install, LaunchAgents/systemd services) are **disabled by default** in sandbox mode.
To explicitly allow them for testing, set:

- `HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1`

---

## Related docs

- `docs/stacks.md` (stacks lifecycle + commands)
- `docs/worktrees-and-forks.md` (worktrees layout + upstream/fork workflows)
