# Stacks (multiple local Happier instances)

`hapsta` supports running **multiple stacks** in parallel on the same machine.

A “stack” is just:

- a dedicated **server port**
- isolated directories for **UI build output**, **CLI home**, and **logs**
- optional per-component overrides (point at specific worktrees)
- (when using `happy-server`) isolated **infra** (Postgres/Redis/Minio) managed per-stack

Stacks are configured via a plain env file stored under:

```
~/.happy/stacks/<name>/env
```

## Create a stack

Non-interactive:

```bash
hapsta stack new exp1 --port=3010 --server=happy-server-light
```

Auto-pick a port:

```bash
hapsta stack new exp2
```

## Create a PR test stack (copy/paste friendly)

If you want maintainers to be able to try your PR quickly, you can give them a single command that:

- creates an isolated stack
- checks out PR(s) into worktrees
- pins those worktrees to the stack
- optionally seeds auth
- optionally starts the stack in dev mode

Example (most common):

```bash
hapsta stack pr pr123 \
  --happy=https://github.com/slopus/happy/pull/123 \
  --happy-cli=https://github.com/slopus/happy-cli/pull/456 \
  --seed-auth --copy-auth-from=dev-auth --link-auth \
  --dev
```

Notes:

- `--remote` (default `upstream`) controls which Git remote is used to fetch `refs/pull/<n>/head`.
- `--seed-auth` uses `hapsta stack auth <stack> copy-from <source>` under the hood, which also best-effort seeds DB Account rows (avoids FK errors like Prisma `P2003`).
- You can use your existing non-stacks Happy install as an auth seed source with:
  - `--copy-auth-from=legacy` (reads from `~/.happy/{cli,server-light}` best-effort)
- `--link-auth` symlinks auth files instead of copying them (keeps credentials in sync, but reduces isolation).
- For full-server stacks (`happy-server`), seeding may need Docker infra:

```bash
hapsta stack pr pr789 \
  --server=happy-server \
  --happy-server=https://github.com/slopus/happy-server/pull/789 \
  --seed-auth --copy-auth-from=dev-auth --with-infra \
  --dev
```

Interactive wizard (TTY only):

```bash
hapsta stack new --interactive
```

The wizard lets you:

- pick the server type (`happy-server-light` or `happy-server`)
- pick or create a worktree for `happy`
- when the selected `happy` checkout is a **monorepo** (`expo-app/`, `cli/`, `server/`), you can choose to **derive** `happy-cli` + `happy-server` from it (keeps UI/CLI/server versions in sync)
  - if the monorepo server includes the SQLite schema, `happy-server-light` is also derived from the same `server/` checkout automatically
- if you don’t derive, you can pick/create worktrees for `happy-cli` and the chosen server component as before
- choose which Git remote to base newly-created worktrees on (defaults to `upstream`)

When creating `--server=happy-server` stacks, hapsta will also reserve additional ports and persist
the stack-scoped infra config in the stack env file (so restarts are stable):

- `HAPPIER_STACK_PG_PORT`
- `HAPPIER_STACK_REDIS_PORT`
- `HAPPIER_STACK_MINIO_PORT`
- `HAPPIER_STACK_MINIO_CONSOLE_PORT`
- `DATABASE_URL`, `REDIS_URL`, `S3_*`

## Run a stack

Dev mode:

```bash
hapsta stack dev exp1
```

Production-like mode:

```bash
hapsta stack start exp1
```

Build UI for a stack (server-light serving):

```bash
hapsta stack build exp1
```

Doctor:

```bash
hapsta stack doctor exp1
```

## Edit a stack (interactive)

To change server flavor, port, or component worktrees for an existing stack:

```bash
hapsta stack edit exp1 --interactive
```

## Switch server flavor for a stack

You can change `happy-server-light` vs `happy-server` for an existing stack without re-running the full edit wizard:

```bash
hapsta stack srv exp1 -- status
hapsta stack srv exp1 -- use happy-server-light
hapsta stack srv exp1 -- use happy-server
hapsta stack srv exp1 -- use --interactive
```

## Switch component worktrees for a stack (`stack wt`)

If you want the **exact** same UX as `hapsta wt`, but scoped to a stack env file:

```bash
hapsta stack wt exp1 -- status happy
hapsta stack wt exp1 -- use happy slopus/pr/my-ui-pr
hapsta stack wt exp1 -- use happy-cli default
```

This updates the stack env file (`~/.happy/stacks/<name>/env`), not repo `env.local` (legacy path still supported).

## Run happy-cli against a specific stack (`stack happy`)

If you want to run a `happy` CLI command against a specific stack (instead of whatever your current shell env points at), use:

```bash
hapsta stack happy exp1 -- status
hapsta stack happy exp1 -- daemon status
```

Stack shorthand also works:

```bash
hapsta exp1 happy status
```

## Stack wrappers you can use

These commands run with the stack env file applied:

- `hapsta stack dev <name>`
- `hapsta stack start <name>`
- `hapsta stack build <name>`
- `hapsta stack doctor <name>`
- `hapsta stack mobile <name>`
- `hapsta stack eas <name> [subcommand...]`
- `hapsta stack happy <name> [-- ...]`
- `hapsta stack srv <name> -- status|use ...`
- `hapsta stack wt <name> -- <wt args...>`
- `hapsta stack tailscale:status|enable|disable|url <name>`
- `hapsta stack service:* <name>`

Global/non-stack commands:

- `hapsta setup` (recommended; installs shims/runtime and bootstraps components)
- (advanced) `hapsta init` (plumbing: shims/runtime/pointer env)
- (advanced) `hapsta bootstrap` (clone/install components and deps)

## Services (autostart)

Each stack can have its own autostart service (so multiple stacks can start at login).

```bash
hapsta stack service exp1 install
hapsta stack service exp1 status
hapsta stack service exp1 restart
hapsta stack service exp1 logs
```

Implementation notes:

- Service name/label is stack-scoped:
  - `main` → `com.happier.stack`
  - `exp1` → `com.happier.stack.exp1`
- macOS: implemented via **launchd LaunchAgents**
- Linux: implemented via **systemd user services** (if available)
- The service persists `HAPPIER_STACK_ENV_FILE`, so you can edit the stack env file without reinstalling.

## Component/worktree selection per stack

When creating a stack you can point components at worktrees:

```bash
hapsta stack new exp3 \\
  --happy=slopus/pr/my-ui-pr \\
  --happy-cli=slopus/pr/my-cli-pr \\
  --server=happy-server
```

Worktree specs are interpreted as:

```
components/.worktrees/<component>/<spec...>
```

So `--happy=slopus/pr/foo` maps to:

```
components/.worktrees/happy/slopus/pr/foo
```

Monorepo note: when `happy` is a `slopus/happy` monorepo checkout, `happy-cli` and `happy-server` share the same git repo/worktree
root under `components/.worktrees/happy/...` (then map to `cli/` and `server/` subdirectories).

You can also pass an absolute path.

## Stack env + repo env precedence

On startup, `hapsta` loads env in this order:

1. `~/.happier-stack/.env` (defaults)
2. `~/.happier-stack/env.local` (optional global overrides; prefer stack env for persistent config)
3. `HAPPIER_STACK_ENV_FILE` (stack env; highest precedence)

`hapsta stack ...` sets `HAPPIER_STACK_ENV_FILE=~/.happy/stacks/<name>/env` and clears any already-exported `HAPPIER_STACK_*` variables so the stack env stays authoritative.

For a full explanation of the different folders/paths (`home` vs `workspace` vs `runtime` vs stack storage) and the exact env precedence rules, see: `[docs/paths-and-env.md](docs/paths-and-env.md)`.

Cloned-repo fallback (before you run `hapsta init`):

1. `<repo>/.env` (defaults)
2. `<repo>/env.local` (optional overrides)
3. `HAPPIER_STACK_ENV_FILE` (stack env)

## Manage per-stack environment variables (including API keys)

To add/update environment variables in a stack env file from the CLI:

```bash
hapsta stack env <stack> set KEY=VALUE [KEY2=VALUE2...]
```

To remove keys:

```bash
hapsta stack env <stack> unset KEY [KEY2...]
```

To inspect:

```bash
hapsta stack env <stack> get KEY
hapsta stack env <stack> list
hapsta stack env <stack> path
```

Notes:

- This is the recommended place for **provider API keys** the daemon needs (example: `OPENAI_API_KEY`).
- Changes apply on the **next start** of the stack/daemon. Restart to pick them up:
  - `main`: `hapsta start --restart`
  - named stack: `hapsta stack start <stack> -- --restart` (or `hapsta stack dev <stack> -- --restart`)

Self-host shortcut (defaults to `main` when not running under a stack wrapper):

```bash
hapsta env set OPENAI_API_KEY=sk-...
```

## Daemon auth + “no machine” on first run

On a **fresh machine** (or any new stack), the daemon may need to authenticate before it can register a “machine”.
If the UI shows “no machine” (or the daemon shows `auth_required`), it usually means the stack-specific CLI home
doesn’t have credentials yet:

- `~/.happy/stacks/<stack>/cli/access.key`

To check / authenticate a stack, run:

```bash
hapsta stack auth <stack> status
hapsta stack auth <stack> login
```

Notes:
- You can run **multiple daemons for the same stack** on **different accounts** using `--identity=<name>`.
  - `default` (no flag): `~/.happy/stacks/<stack>/cli/...`
  - `--identity=account-b`: `~/.happy/stacks/<stack>/cli-identities/account-b/...`
- To authenticate an identity without auto-opening a browser, use `--no-open` (it prints the URL so you can open it
  in the browser profile/incognito window you want):

```bash
hapsta stack auth <stack> login --identity=account-a --no-open
hapsta stack auth <stack> login --identity=account-b --no-open
```

- To start/stop an identity’s daemon explicitly:

```bash
hapsta stack daemon <stack> start --identity=account-a
hapsta stack daemon <stack> stop  --identity=account-a
```

- For the **main** stack, use `<stack>=main` and the default `<port>=3005` (unless you changed it).
- If you use Tailscale Serve, `HAPPY_WEBAPP_URL` should be your HTTPS URL (what you get from `hapsta tailscale url`).
- Logs live under:
  - default identity: `~/.happy/stacks/<stack>/cli/logs/`
  - named identities: `~/.happy/stacks/<stack>/cli-identities/<identity>/logs/`

## JSON mode

For programmatic usage:

```bash
hapsta stack list --json
hapsta stack new exp3 --json
hapsta stack edit exp3 --interactive --json
```
