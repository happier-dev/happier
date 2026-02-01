# Stacks (multiple local Happier instances)

`hstack` supports running **multiple stacks** in parallel on the same machine.

A “stack” is just:

- a dedicated **server port**
- isolated directories for **UI build output**, **CLI home**, and **logs**
- a repo checkout pin (point at a specific worktree/checkout)
- (when using `happy-server`) isolated **infra** (Postgres/Redis/Minio) managed per-stack

Stacks are configured via a plain env file stored under:

```
~/.happier/stacks/<name>/env
```

## Create a stack

Non-interactive:

```bash
hstack stack new exp1 --port=3010 --server=happy-server-light
```

Auto-pick a port:

```bash
hstack stack new exp2
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
hstack stack pr pr123 \
  --repo=https://github.com/leeroybrun/happier-dev/pull/123 \
  --seed-auth --copy-auth-from=dev-auth --link-auth \
  --dev
```

Notes:

- `--remote` (default `upstream`) controls which Git remote is used to fetch `refs/pull/<n>/head`.
- `--seed-auth` uses `hstack stack auth <stack> copy-from <source>` under the hood, which also best-effort seeds DB Account rows (avoids FK errors like Prisma `P2003`).
- `--link-auth` symlinks auth files instead of copying them (keeps credentials in sync, but reduces isolation).
 - For full-server stacks (`happy-server`), seeding may require Docker infra to be running.

Interactive wizard (TTY only):

```bash
hstack stack new --interactive
```

The wizard lets you:

- pick the server type (`happy-server-light` or `happy-server`)
- pick or create a repo worktree for the Happier monorepo
- choose which Git remote to base newly-created worktrees on (defaults to `upstream`)

When creating `--server=happy-server` stacks, hstack will also reserve additional ports and persist
the stack-scoped infra config in the stack env file (so restarts are stable):

- `HAPPIER_STACK_PG_PORT`
- `HAPPIER_STACK_REDIS_PORT`
- `HAPPIER_STACK_MINIO_PORT`
- `HAPPIER_STACK_MINIO_CONSOLE_PORT`
- `DATABASE_URL`, `REDIS_URL`, `S3_*`

## Run a stack

Dev mode:

```bash
hstack stack dev exp1
```

Production-like mode:

```bash
hstack stack start exp1
```

Build UI for a stack (server-light serving):

```bash
hstack stack build exp1
```

Doctor:

```bash
hstack stack doctor exp1
```

## Edit a stack (interactive)

To change server flavor, port, or repo worktree for an existing stack:

```bash
hstack stack edit exp1 --interactive
```

## Switch server flavor for a stack

You can change `happy-server-light` vs `happy-server` for an existing stack without re-running the full edit wizard:

```bash
hstack stack srv exp1 -- status
hstack stack srv exp1 -- use happy-server-light
hstack stack srv exp1 -- use happy-server
hstack stack srv exp1 -- use --interactive
```

## Switch repo worktree for a stack (`stack wt`)

If you want the **exact** same UX as `hstack wt`, but scoped to a stack env file:

```bash
hstack stack wt exp1 -- status
hstack stack wt exp1 -- use slopus/pr/my-ui-pr
hstack stack wt exp1 -- use default
```

This updates the stack env file (`~/.happier/stacks/<name>/env`), not repo `env.local` (legacy path still supported).

## Run happy-cli against a specific stack (`stack happy`)

If you want to run a `happy` CLI command against a specific stack (instead of whatever your current shell env points at), use:

```bash
hstack stack happy exp1 -- status
hstack stack happy exp1 -- daemon status
```

Stack shorthand also works:

```bash
hstack exp1 happy status
```

## Stack wrappers you can use

These commands run with the stack env file applied:

- `hstack stack dev <name>`
- `hstack stack start <name>`
- `hstack stack build <name>`
- `hstack stack doctor <name>`
- `hstack stack mobile <name>`
- `hstack stack eas <name> [subcommand...]`
- `hstack stack happy <name> [-- ...]`
- `hstack stack srv <name> -- status|use ...`
- `hstack stack wt <name> -- <wt args...>`
- `hstack stack tailscale:status|enable|disable|url <name>`
- `hstack stack service:* <name>`

Global/non-stack commands:

- `hstack setup` (recommended; installs shims/runtime and bootstraps the monorepo)
- (advanced) `hstack init` (plumbing: shims/runtime/pointer env)
- (advanced) `hstack bootstrap` (clone/install monorepo + deps)

## Services (autostart)

Each stack can have its own autostart service (so multiple stacks can start at login).

```bash
hstack stack service exp1 install
hstack stack service exp1 status
hstack stack service exp1 restart
hstack stack service exp1 logs
```

Implementation notes:

- Service name/label is stack-scoped:
  - `main` → `com.happier.stack`
  - `exp1` → `com.happier.stack.exp1`
- macOS: implemented via **launchd LaunchAgents**
- Linux: implemented via **systemd user services** (if available)
- The service persists `HAPPIER_STACK_ENV_FILE`, so you can edit the stack env file without reinstalling.

## Repo/worktree selection per stack

When creating a stack you can point the stack at a repo worktree:

```bash
hstack stack new exp3 \\
  --repo=slopus/pr/my-feature \\
  --server=happy-server
```

Worktree specs are interpreted as:

```
<workspace>/.worktrees/<spec...>
```

So `--repo=slopus/pr/foo` maps to:

```
<workspace>/.worktrees/slopus/pr/foo
```

You can also pass an absolute path.

## Stack env + repo env precedence

On startup, `hstack` loads env in this order:

1. `~/.happier-stack/.env` (defaults)
2. `~/.happier-stack/env.local` (optional global overrides; prefer stack env for persistent config)
3. `HAPPIER_STACK_ENV_FILE` (stack env; highest precedence)

`hstack stack ...` sets `HAPPIER_STACK_ENV_FILE=~/.happier/stacks/<name>/env` and clears any already-exported `HAPPIER_STACK_*` variables so the stack env stays authoritative.

For a full explanation of the different folders/paths (`home` vs `workspace` vs `runtime` vs stack storage) and the exact env precedence rules, see: `[docs/paths-and-env.md](docs/paths-and-env.md)`.

Cloned-repo fallback (before you run `hstack init`):

1. `<repo>/.env` (defaults)
2. `<repo>/env.local` (optional overrides)
3. `HAPPIER_STACK_ENV_FILE` (stack env)

## Manage per-stack environment variables (including API keys)

To add/update environment variables in a stack env file from the CLI:

```bash
hstack stack env <stack> set KEY=VALUE [KEY2=VALUE2...]
```

To remove keys:

```bash
hstack stack env <stack> unset KEY [KEY2...]
```

To inspect:

```bash
hstack stack env <stack> get KEY
hstack stack env <stack> list
hstack stack env <stack> path
```

Notes:

- This is the recommended place for **provider API keys** the daemon needs (example: `OPENAI_API_KEY`).
- Changes apply on the **next start** of the stack/daemon. Restart to pick them up:
  - `main`: `hstack start --restart`
  - named stack: `hstack stack start <stack> -- --restart` (or `hstack stack dev <stack> -- --restart`)

Self-host shortcut (defaults to `main` when not running under a stack wrapper):

```bash
hstack env set OPENAI_API_KEY=sk-...
```

## Daemon auth + “no machine” on first run

On a **fresh machine** (or any new stack), the daemon may need to authenticate before it can register a “machine”.
If the UI shows “no machine” (or the daemon shows `auth_required`), it usually means the stack-specific CLI home
doesn’t have credentials yet:

- `~/.happier/stacks/<stack>/cli/access.key`

To check / authenticate a stack, run:

```bash
hstack stack auth <stack> status
hstack stack auth <stack> login
```

Notes:
- You can run **multiple daemons for the same stack** on **different accounts** using `--identity=<name>`.
  - `default` (no flag): `~/.happier/stacks/<stack>/cli/...`
  - `--identity=account-b`: `~/.happier/stacks/<stack>/cli-identities/account-b/...`
- To authenticate an identity without auto-opening a browser, use `--no-open` (it prints the URL so you can open it
  in the browser profile/incognito window you want):

```bash
hstack stack auth <stack> login --identity=account-a --no-open
hstack stack auth <stack> login --identity=account-b --no-open
```

- To start/stop an identity’s daemon explicitly:

```bash
hstack stack daemon <stack> start --identity=account-a
hstack stack daemon <stack> stop  --identity=account-a
```

- For the **main** stack, use `<stack>=main` and the default `<port>=3005` (unless you changed it).
- If you use Tailscale Serve, `HAPPY_WEBAPP_URL` should be your HTTPS URL (what you get from `hstack tailscale url`).
- Logs live under:
  - default identity: `~/.happier/stacks/<stack>/cli/logs/`
  - named identities: `~/.happier/stacks/<stack>/cli-identities/<identity>/logs/`

## JSON mode

For programmatic usage:

```bash
hstack stack list --json
hstack stack new exp3 --json
hstack stack edit exp3 --interactive --json
```
