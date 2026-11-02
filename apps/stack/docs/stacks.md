# Stacks (multiple local Happier instances)

`hstack` supports running **multiple stacks** in parallel on the same machine.

A “stack” is just:

- a dedicated **server port**
- isolated directories for **UI build output**, **CLI home**, and **logs**
- a repo checkout pin (point at a specific worktree/checkout)
- (when using `happier-server`) isolated **infra** (Postgres/Redis/Minio) managed per-stack

Stacks are configured via a plain env file stored under:

```
~/.happier/stacks/<name>/env
```

## Create a stack

Non-interactive (explicitly disable the TTY wizard):

```bash
hstack stack new exp1 --port=3010 --server=happier-server-light --non-interactive
```

Use an ephemeral port (selected when the stack starts):

```bash
hstack stack new exp2 --non-interactive
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
  --repo=https://github.com/happier-dev/happier/pull/123 \
  --seed-auth --copy-auth-from=dev-auth --link-auth \
  --dev
```

Notes:

- `--remote` (default `upstream`) controls which Git remote is used to fetch `refs/pull/<n>/head`.
- `--seed-auth` uses `hstack stack auth <stack> copy-from <source>` under the hood, which also best-effort seeds DB Account rows (avoids FK errors like Prisma `P2003`).
- `--link-auth` symlinks auth files instead of copying them (keeps credentials in sync, but reduces isolation).
- For full-server stacks (`happier-server`), seeding may require Docker infra to be running.

## Auth seeding (recommended: dev-auth)

Create the `dev-auth` seed stack once, authenticate once, then reuse it when creating new stacks:

```bash
hstack auth seed
```

Interactive wizard (TTY only):

```bash
hstack stack new --interactive
```

The wizard lets you:

- pick the server type (`happier-server-light` or `happier-server`)
- pick or create a repo worktree for the Happier monorepo
- choose which Git remote to base newly-created worktrees on (defaults to `upstream`)

When creating `--server=happier-server` stacks, hstack will also reserve additional ports and persist
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

### Development port allocation (0.3 development)

Fresh remote targets choose deterministic server/daemon ports in 10000–17999
and Expo ports in 21000–28999. Fresh repo-local servers use 30005–32004 by
default. These pools avoid the supported platforms' default ephemeral ranges
and the local Expo pool at 18081–20080.

Server/daemon pins and retained runtime ports keep their endpoints when defaults
change. Explicit server port-range overrides retain their selection precedence.
A failed fresh server/daemon forward can select another candidate through the
existing target retry; retained routes stay fixed. Expo has no separate
port-collision reallocation path.

### Source stack reload (0.3 development)

`hstack stack start exp1 --runtime=source --ui=export --restart` prepares the
replacement server, daemon and web export while the incumbent keeps serving.
The source selection owner checks the daemon command loader, boots the server
against scratch SQLite or PGlite data on an available loopback port, and loads
the export in an isolated browser. Preparation runs on each actual service
host, under the existing resource admission policy. Compiler services are
released before browser smoke; the live Stack database is never used by smoke.
For a light server backed by PostgreSQL, smoke loads the real server entry and
its startup imports in an isolated process with database credentials removed,
then returns before database initialization. A module-load failure refuses the
replacement. This verifies imports, not PostgreSQL migrations or connectivity.

Only successful checks permit selection and the existing restart owner's
cutover. Startup then reuses the checked bundles and export. Failed or cancelled
preparation preserves the loaded runtime; build/smoke failures preserve its
selection too. `stack info` reports `runtime.sourceReload`, including the failure
and its `run.reload.*.log` path. Selection and loaded process identity remain
separate facts.

Finite web exports capture authored inputs and share installed dependencies.
Metro includes the real installed module roots, including workspace-local
dependencies mounted into the capture. A failed export counts as source drift
only when input bytes changed during that attempt; an unchanged-input failure
returns its diagnostic instead of waiting for source edits.

A remote source worker failure retries through this preparation path against
the synchronized current source. Readiness must come from the successor runtime
owner, even when it uses the same bundle. Transport-only SSH or tunnel loss
retains the existing loaded source selection for recovery.

A source start superseded by a newer start is terminal for the older controller.
It closes its own SSH workers, forwards and owner-death watchdog without retiring
the replacement runtime or publishing another retry.

Source-based remote control helpers use the command executor's mirror admission
and freshness barrier. A missing or unhealthy mirror leaves browser retirement
unconfirmed with a target-specific warning; cleanup does not execute stale helper
code from that mirror. A reachable helper failure still prevents stop finalization,
and both JSON and console output retain its sanitized cause.

Scan and transition problems block remote dispatch, including `.project/` data
and captures. Refusals name the problem paths. Known transient races use the
existing fresh-scan recovery and require a clean result before dispatch; file
extensions and local file types cannot establish what a failed transition left
on the mirror. Excluded or malformed problem evidence, conflicts, disconnected
endpoints and incomplete synchronization cycles also remain blocking.

Write live or repeatedly rewritten captures to `.project/tmp/**`, a scratch
directory, or a Mutagen-ignored suffix under `plans/` (for example `.ndjson`,
`.jsonl`, `.png`, `.webm`, `.log`, `.trace` or `.har`). The existing ignore policy
also excludes `browser-diagnostics.json` under `plans/`. Status and dispatch
share one readiness policy.

Use `local` placement for services on the controller. A separate mirror on the
same host must remain outside the authoritative checkout: the synchronization
producer rejects equal, nested or enclosing destinations before creating a mirror,
including symlink aliases. Identical paths on different hosts remain valid.

During preparation, source-stack health reports `runtime_preparing`; after
selection it reports `runtime_identity_pending` until the replacement identity
is loaded. A healthy response from the incumbent alone cannot confirm the
replacement. Lost remote daemon transport reports `daemon_unknown` and retains
the recorded loaded identity; its target lifecycle phase remains visible in
`stack info` until readiness or retirement is confirmed.

The daemon check runs `daemon --help` in an empty temporary CLI home: it takes no
daemon lock and registers no second Machine. It detects broken imports and
command loading, but cannot prove authenticated Machine registration or code
executed only after daemon startup. The browser check covers initial rendering,
script delivery and boot exceptions, not later authenticated routes or tooltip
interactions. Full-server infrastructure and external PostgreSQL/MySQL smoke
databases are not provisioned by this path. Full-server and MySQL reloads fail
before retirement; light PostgreSQL reloads use the database-free import check.
The complete named-Stack cutover remains a manual validation step for the
operator applying these development tooling changes.

### Daemon-only source reload (0.3 development)

For a running source-snapshot stack, rebuild and reload only its daemon:

```bash
node ./apps/stack/scripts/repo_local.mjs stack daemon exp1 restart --runtime=source --json
node ./apps/stack/scripts/repo_local.mjs stack info exp1 --json
```

This follows the observed daemon host, synchronizes its source mirror, selects the current daemon bundle, and uses authenticated `/restart` with an empty body to preserve Session runners. It does not restart the server or UI. Require the daemon's selected source identity to equal its loaded identity and actual readiness. The incumbent must already include the source-selection resolver; older loaded daemons need one owner-controlled initial load before this command can load newer source through `/restart`.

Source startup with `--ui=borrowed` skips the web export and uses the configured `HAPPIER_STACK_EXPO_SOURCE_STACK`. Setting the producer reference alone does not select borrowed UI. UI-only changes need a deliberate browser reload.

### Place QA browsers independently (0.3 development)

Set a browser pool without changing the stack's daemon placement:

```bash
node ./apps/stack/scripts/repo_local.mjs stack env exp1 set HAPPIER_STACK_QA_BROWSER_TARGETS=linux3,linux2
node ./apps/stack/scripts/repo_local.mjs dev-targets browser start qa1 --stack=exp1 --url=<qa-ui-url>
```

The browser selector compares current unreserved memory among those configured hosts for each browser lifetime. It writes no Machine pin and fails closed if no pool host is usable. When the browser setting is absent or empty, it retains the existing daemon-pool/default selection. Keep the foreground browser handle and interrupt it after QA to retire its browser, profile, and forwards. In 0.3 development, acquisition also requires a CDP WebSocket command response through the returned forward. A silent endpoint is retired after the default 30-second CDP attach window and replaced once before a handle is returned. Failed retirement stops acquisition; it never allocates a replacement beside an unconfirmed old browser. Loss of a managed browser's control channel also closes its browser and removes its owned temporary profile.

## Edit a stack (interactive)

To change server flavor, port, or repo worktree for an existing stack:

```bash
hstack stack edit exp1 --interactive
```

## Switch server flavor for a stack

You can change `happier-server-light` vs `happier-server` for an existing stack without re-running the full edit wizard:

```bash
hstack stack srv exp1 -- status
hstack stack srv exp1 -- use happier-server-light
hstack stack srv exp1 -- use happier-server
hstack stack srv exp1 -- use --interactive
```

## Switch repo worktree for a stack (`stack wt`)

If you want the **exact** same UX as `hstack wt`, but scoped to a stack env file:

```bash
hstack stack wt exp1 -- status
hstack stack wt exp1 -- use pr/my-ui-pr
hstack stack wt exp1 -- use default
```

This updates the stack env file (`~/.happier/stacks/<name>/env`), not repo `env.local` (legacy path still supported).

## Run the Happier CLI against a specific stack (`stack happier`)

If you want to run a `happier` CLI command against a specific stack (instead of whatever your current shell env points at), use:

```bash
hstack stack happier exp1 -- status
hstack stack happier exp1 -- daemon status
```

Stack shorthand also works:

```bash
hstack exp1 happier status
```

In 0.3 development, when the daemon is placed on a remote dev target, this
passthrough runs the CLI on that host with the target's stack identity and CLI
home. Output and exit status return to the caller. A recorded local daemon
placement takes precedence over a configured remote preference.

Use `hstack stack happier <name> --runtime -- <args>` to follow the active
runtime. For a running source-snapshot daemon, `--runtime` uses its recorded
source launch rather than a checkout's potentially stale CLI dist. Missing
loaded source code produces an error; the command does not rebuild it.
`--runtime=built` explicitly selects a native runtime snapshot, while `--source`
explicitly selects checkout source. Filesystem arguments to a remotely executed
CLI refer to that host's filesystem.

## Stack wrappers you can use

These commands run with the stack env file applied:

- `hstack stack dev <name>`
- `hstack stack start <name>`
- `hstack stack build <name>`
- `hstack stack doctor <name>`
- `hstack stack mobile <name>`
- `hstack stack eas <name> [subcommand...]`
- `hstack stack happier <name> [-- ...]`
- `hstack stack srv <name> -- status|use ...`
- `hstack stack wt <name> -- <wt args...>`
- `hstack stack tailscale:status|enable|disable|url <name>`
- `hstack stack service:* <name>`

Global/non-stack commands:

- `hstack setup-from-source` (recommended; installs shims/runtime and bootstraps the monorepo)
  - Deprecated alias: `hstack setup`
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
  --repo=local/my-feature \\
  --server=happier-server
```

Worktree specs are interpreted relative to the workspace:

```
main                -> <workspace>/main
dev                 -> <workspace>/dev
pr/<...>            -> <workspace>/pr/<...>
local/<...>         -> <workspace>/local/<owner>/<...>
tmp/<...>           -> <workspace>/tmp/<owner>/<...>
```

So `--repo=pr/foo` maps to:

```
<workspace>/pr/foo
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

In source development, the TUI keeps the server and Expo available while daemon credentials are missing, so its `a` login action can complete. The daemon waits for authentication before starting; the development runner checks again after credentials are created.

In 0.3 development, daemon readiness checkpoints continue while the start wrapper or daemon remains live, including before it writes its state file. Shutdown cancels and joins the owned start wrapper. A failed `hstack stack daemon <stack> start` or `restart` exits nonzero; a returned startup failure produces `ok: false` with its reason in JSON mode. The long-running TUI can remain available after the attempt fails.

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
- If you use Tailscale Serve, `HAPPIER_WEBAPP_URL` should be your HTTPS URL (what you get from `hstack tailscale url`).
- Logs live under:
  - default identity: `~/.happier/stacks/<stack>/cli/logs/`
  - named identities: `~/.happier/stacks/<stack>/cli-identities/<identity>/logs/`

## Runner log disk budget (0.3 development)

Background `start` and `dev` runners watch their own `logs/run.<timestamp>.log`
or `logs/dev.<timestamp>.log`. The retention owner rotates when a file grows
past 64 MiB, half its existing 128 MiB historical-log budget. It saves the most
recent 64 MiB in `<runner>.log.1`, truncates the active file in place and writes
a `runner log rotated` marker. Existing inherited stdout/stderr descriptors and
`hstack logs --follow` keep the same file and inode.

The same retention owner counts rotated segments in its eight-file / 128 MiB
history budget, giving one active runner a 192 MiB steady-state disk budget.
Writes arriving before the filesystem notification is handled can temporarily
exceed the threshold. Copy/truncate is diagnostic best effort: output written
during the copy/truncate window can be lost. History is not a transcript or an
audit trail. Unrelated logs and explicitly preserved live runner files remain
outside this budget. The existing exception retaining one oversized newest
historical file still applies until bounded rotation produces newer history.

Rotation starts with newly launched runners; restarting existing stacks is an
operator decision. Watcher or rotation errors emit a warning and stop that
watcher rather than interrupting the Stack. Inspect the warning and resolve the
filesystem problem before the next launch.

Stack server logging defaults to `warn`, honors explicit logging overrides,
and uses the server's configured `HAPPIER_SERVER_LOG_FORMAT`. Enabling
`HAPPIER_WEB_LATENCY_TRACE=1` with debug logging retains request/Action summaries
and failed spans; successful database span detail requires `trace` logging.

## JSON mode

For programmatic usage:

```bash
hstack stack list --json
hstack stack new exp3 --json
hstack stack edit exp3 --interactive --json
```
