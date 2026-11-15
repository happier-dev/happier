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

In 0.3 development, a stack remembers its automatically chosen controller port
and each server host's chosen private port in `stack.runtime.json`, including
after Stop. Startup reuses a remembered port when free, after the stack's own
teardown completes. A foreign listener is left running; an automatically chosen
port moves to a free alternative and `stack info --json` reports the previous
and current ports with reason `previous-port-occupied` under
`runtime.portAllocations.controller` and `runtime.portAllocations.servers.<target>`.
Explicit port pins and auxiliary infrastructure ports still fail closed when occupied.
A remembered allocation alone is not a running service or a verified endpoint.

In 0.3 development, a requested local server that fails during startup makes the
dev runner exit with a failure before starting the daemon. Restore unavailable
database or object-storage dependencies, then start the stack again. Startup
does not classify a generic server or migration exit as a transient dependency
failure and retry it automatically. Stop and restart can retire a daemon that
never published its HTTP control port; it has no daemon-held Sessions to clean.

One Session's or browser host's incomplete cleanup is reported as a typed,
retryable warning and does not refuse the whole stop or restart. Browser hosts
are swept again at the next cleanup boundary. A remote Session cleanup refusal
retains the existing target retirement record for the next boundary; local
Session retirement retains the daemon's Session markers for startup/reconnect
recovery. Invalid browser confirmation remains visibly incomplete. Core Stack
process ownership and shutdown confirmation still govern finalization.

QA must read the current controller URL from `urls.internalServerUrl` in
`hstack stack info <stack> --json` before a run, including after a restart.
Use that published URL rather than a remembered port, the remote host's private
service port, or an inferred localhost alias. A stopped stack has no live
controller URL. The stack's owner performs restarts and confirms readiness.

### Source stack reload (0.3 development)

Source CLI and daemon launches use their retained runtime's installed dependency
closure. A completed UI-only dependency refresh leaves them usable when that
closure is unchanged. Changed runtime dependencies and unfinished or failed
dependency publications still require recovery through the dependency owner.

`hstack stack dev <stack> --restart` prepares the current daemon source before
replacing it through the daemon lifecycle owner. Ordinary startup and recovery
continue to use the retained source generation.

In 0.3 development, full reloads, retained source-capture adoption and dev
source-generation swaps refresh running named identity daemons after the default
daemon. Discovery uses the daemon host's identity homes as well as recorded
lifecycle intent, so a stale runtime file does not hide a running fixture identity.
The source run owner refreshes preserved identities using the selected daemon
launch, including when the healthy default daemon is adopted. Other full reloads
capture participants before retirement; dev swaps reuse the prepared daemon
launch. Source activation preserves named identity Session runners. Stopped
identities remain stopped, and an identity already on the selected source
entrypoint is reused. An identity restart failure is reported with a typed reason
and does not fail or retry the stack reload. Discovery reports a scoped or
unreachable identity as skipped and continues restoring the other eligible
identities independently. The final participant verification still reports
unavailable participants as `NOT_READY`.
Each discovered named identity emits one restore outcome: `restored`, `refused`
with its typed code/reason, or `skipped` with its eligibility reason. Source
reload status retains these diagnostics under
`runtime.sourceReload.identityRestore` in `stack info --json`, alongside the
existing preparation result. A non-starting daemon is never counted as restored.

Use `hstack stack start <stack> --runtime=source --restart --verify` for a
background reload followed by one `READY` or `NOT_READY` verdict. Verification
consumes Stack's selected/loaded identities and authenticated daemon-control
observation, checks the retained runtime's sign-in through `auth status`,
starts one real Agent Session through the daemon's Session host, runner and
attach (`session create` with no prompt, so no model turn), then stops and
archives it, and boots the current UI in the managed QA browser pool. A failed
start reports `check: "agent"` with only the owner's error codes. The browser loads after
the serving process has started; an old `Web Bundled` log line cannot satisfy
this check. Stacks with UI disabled skip the browser step. Borrowed Expo is
verified without restarting its producer.

QA source stacks run a committed revision plus only the files the Stack declares
as its own uncommitted overlay. Other lanes' edits in the shared checkout never
enter a QA build. The repository dev coordinator builds the newest HEAD whenever
HEAD or the installed dependencies change. A plain reload selects the latest
revision that producer built, so it adopts a finished product with no build:

```bash
hstack stack start exp1 --runtime=source --restart --verify                 # latest built revision
hstack stack start exp1 --runtime=source --restart --verify --rev=HEAD      # exactly HEAD (built once if needed)
hstack stack start exp1 --runtime=source --restart --verify --overlay=apps/cli/src/foo.ts,packages/protocol/src/bar
```

`--rev` takes any commit. `--overlay` (or `hstack stack env set
HAPPIER_STACK_SOURCE_OVERLAY=<paths>`) takes repository-relative files or
directories; they are layered on HEAD (or `--rev`), and only those paths keep
their checkout bytes. Declare every uncommitted file your change depends on,
including another lane's. An overlay build is keyed by the revision plus the
overlay's digest: other Stacks with the same overlay reuse it, and it never
becomes the latest built revision. The reload log names the selected revision,
and PREPARED prints `rev <component>=<sha>[+overlay:<digest>]` next to the
capture time and input identity.

Source-tree reloads (rollout, owner 2026-11-14): with
`hstack stack env <stack> set HAPPIER_STACK_SOURCE_TREES=1`, a reload builds no
bundle. Each host keeps one read-only base tree per revision, built once from the
revision's Git objects (`git archive` on the controller; a mirror host without Git
objects asks the controller for that archive), never from a working tree. A reload at
a later commit reuses the newest compatible base and applies that commit's
changed files plus the Stack's `--overlay` files to the Stack's own hardlink
clone; a package manifest or lockfile change builds a new base. Server and daemon
run that clone from source and take no compiler admission. When the commit or
overlay touches plugin inputs, only the bundled-plugin derivation reruns for that
Stack. Each reload prepares a new tree beside the running one; `stack stop`
(including a restart's stop) releases every tree except the selected one, and a
base no Stack tree references is deleted (the newest base per host is kept).

An unbuilt revision is built once by the repository producer under its existing
lock; the consumer never compiles. If a completed capture's consumed bytes equal
the revision's, it is adopted instead. `--source-after=<ISO timestamp>` remains
accepted as an additional capture-time boundary. Preparation still
checks the replacement and the existing restart owner performs cutover. Startup
and verification still run after fast adoption.
Before cutover, daemon replacement admission requires its bundled-plugin
publication failures to be empty or unchanged from the incumbent. Missing or
malformed replacement evidence, or a changed failure list, refuses preparation
and retains the incumbent with the reason.
The replacement daemon's existing readiness wait also requires its new log to
show `Machine registered` without `registration unavailable`, and its loaded
Agent catalog count to be at least the incumbent's. A failed check reports
`NOT_READY` with the reason after cutover. Bundled plugin publication refusals name each failing plugin and diagnostic code, omitting diagnostic messages and paths. The lead re-adopts the previous green
capture; this does not provide automatic rollback or overlapping handover.
Execution hosts have no Git metadata: the controller ships a description of the
selected revision to each host's reload worker, which deletes it after use.

App-only screen edits are served by borrowed Expo/Metro, which reads the live
checkout; refresh the app or browser to replay them. A QA verdict on a revision
uses that revision's shared web export (`--ui=export` builds it once; every Stack
on the same revision and overlay adopts it).

Every verdict includes elapsed milliseconds. `NOT_READY` identifies the failing
check and its evidence; `READY` includes the component identities. Verification
also requires an available, identified managed CLI after reload. When its
pre-reload identity is available, verification compares the binary selected
on the daemon host before and after reload; an unexpected replacement is
`NOT_READY`. A missing or unavailable pre-reload identity records
`baseline: unavailable` and allows the reload to repair the runtime; only
the baseline comparison is skipped. Selected and loaded runtime identities
must still match. Verification does not update that installation. A missing sign-in,
pending readiness, unavailable browser pool, or failed render returns
`NOT_READY` with a nonzero exit status and leaves the existing lifecycle owner
in control. Re-run after resolving the reported prerequisite. `--verify`
cannot be combined with the existing `--json` dry-run option.

For a server-only CPU profile in 0.3 development, run `hstack stack start <stack> --runtime=source --restart --server-cpu-prof`. Local and remote source servers receive `--cpu-prof --cpu-prof-interval=10000 --disable-sigusr1`; startup prints the serving host's output directory, `<stack-state-root>/logs/server-cpu-prof`. On POSIX, finish the capture with a normal `hstack stack stop <stack>` or the next normal restart: after shutdown hooks complete, the server exits normally so Node writes the `.cpuprofile`. Forced termination, including SIGKILL and Windows tree termination, does not guarantee a profile. This opt-in is not saved in the Stack env or runtime selection; pass it again for a later start. Daemon and CLI processes do not receive the Node flags. Native runtime snapshots do not support this switch.

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

When a module load or bundle fails, the existing refusal reports
`firstFailingModule`, `entryGraph` and `component`. A compiler or runtime probe's
module location takes precedence. If it has no location, preparation reuses that
component's `check:entry-loads` graph once after the failure. Successful reloads
do not run this additional diagnostic. The fields survive remote preparation
and appear in the one-line refusal, startup/reload log and
`stack info --json` under `runtime.sourceReload`.
The refusal retains the original failure code, including a loader code such as
`ERR_MODULE_NOT_FOUND` behind a preparation process's numeric exit status.
Later dependency drift does not replace a failed preparation's cause.

Before activating an SQLite or PostgreSQL server replacement, reload runs the
canonical migration deploy against that stack's own database. An explicit
reload performs this preflight even when ordinary-start migrations are disabled.
A deploy failure retains the incumbent and reports its refusal code and
`failedMigration` when the migration executor identifies the failed SQL. A
connection or setup failure is reported without guessing a failed migration.

A shared-database consumer only reads the source database's migration ledger.
Every pending migration appears in `missingMigrations`, alongside `sourceStack`
and code `ESHAREDDBMIGRATIONSMISSING`; unavailable ledger evidence reports
`ESHAREDDBMIGRATIONSTATUSUNAVAILABLE`. Ask the named source stack's owner to
deploy, then retry the consumer reload. A QA stack never deploys or repairs the
shared development database. PGlite keeps its existing exclusive migration path
after the incumbent releases the data-directory lock.

Only successful checks permit selection and the existing restart owner's
cutover. Startup then reuses the checked bundles and export. Failed or cancelled
preparation preserves the loaded runtime; build/smoke failures preserve its
selection too. `stack info` reports `runtime.sourceReload`, including the failure
and its `run.reload.*.log` path. Selection and loaded process identity remain
separate facts.

A successful source daemon start or Session-preserving restart clears a retained
daemon reload refusal after the loaded identity is confirmed. It preserves a
refusal for another component and any refusal whose selected daemon generation
has not loaded.

Finite web exports capture authored inputs and share installed dependencies.
Metro includes the real installed module roots, including workspace-local
dependencies mounted into the capture. A failed export counts as source drift
only when input bytes changed during that attempt; an unchanged-input failure
returns its diagnostic instead of waiting for source edits.

A remote runtime failure retries through this preparation path against the
synchronized current source. Readiness must come from the successor runtime
owner, even when it uses the same bundle. Remote workers launch the existing
background Stack owner and observe its runtime-state and log publications;
an SSH disconnect cannot terminate that owner. Transport-only SSH or tunnel
loss uses the existing reconnect path, verifies health and selected/loaded
identity, and reattaches without startup, retirement or source capture. If the
runtime is gone after SSH loss, recovery restarts its recorded source selection
with `--reuse-source-runtime`. Local source recovery also accepts this flag with
`--runtime=source --no-dev-targets`; the printed cleanup recovery command includes
these flags so it can reuse the retained capture after Stop clears runtime state.
Explicit Stop still retires the recorded owner,
and the owner-death watchdog still sweeps a runtime whose owner actually dies.

A source start superseded by a newer start is terminal for the older controller.
It closes its own SSH workers, forwards and owner-death watchdog without retiring
the replacement runtime or publishing another retry.

In 0.3 development, remote browser retirement runs the native process-ownership
helper without source-runtime bootstrap, mirror admission or dependency publication.
An unreachable host or missing retirement helper leaves cleanup unconfirmed with
`browser_cleanup_unreachable:<target>` and allows stop to proceed. The existing
sweep reclaims marked browsers on the next contact. A reachable helper's ownership
failure or invalid confirmation still prevents finalization; JSON and console
output retain its sanitized cause.

In 0.3 development, `stack info` observes remote relay runtime state through the
existing command transport without checking source-mirror readiness or forcing
a Mutagen flush. Browser start uses this same observation when resolving its
Stack URL. Relay preparation and source-consuming commands retain their source
freshness barrier.

Scan and transition problems block remote source-consuming dispatch, including `.project/` data
and captures. Refusals name the problem paths. Known transient races use the
existing fresh-scan recovery and require a clean result before dispatch; file
extensions and local file types cannot establish what a failed transition left
on the mirror. Excluded or malformed problem evidence, conflicts, disconnected
endpoints and incomplete synchronization cycles also remain blocking.

Write live or repeatedly rewritten captures to `.project/tmp/**`, a scratch
directory, or a Mutagen-ignored suffix under `plans/` (for example `.ndjson`,
`.jsonl`, `.png`, `.webm`, `.log`, `.trace` or `.har`). The existing ignore policy
also excludes `browser-diagnostics.json` and directories named `logs`,
`timelines`, `captures` or `tmp` anywhere under `.project/plans/`, regardless
of file extension. The source allowlist retains `.project/plans/`,
`.project/tasks/`, `.project/scripts/` and root `.project/*.md`; worker inputs
such as typecheck baselines, migration ledgers, briefs and lane configs remain
synchronized outside those excluded artifact directories. Status and dispatch
share one readiness policy. A missing staged file makes Mutagen schedule a
fresh cycle itself; the POSIX dispatch barrier continues these known transient
cycles until clean and remains cancellable. Candidate probes observe this
recoverable state without flushing unselected mirrors. Stopping the writer can therefore
restore readiness without a reset. If a source problem persists, `hstack dev-targets sync <target>` owns
the explicit fresh scan and still requires a clean result.

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

Source reload verification also reports `participants`: the default daemon and named CLI identities recorded by the Stack daemon lifecycle commands or observed running in its identity homes. Inactive homes without recorded lifecycle intent are omitted. Each running participant reports its loaded bundle identity and source-capture time. A different selected bundle yields `participant_source_stale`; missing bundle evidence yields `participant_source_unknown`; unavailable control yields `participant_unavailable`. These make the verdict `NOT_READY`. An identity deliberately stopped by its owner is exempt only when observed stopped; a still-running participant reports `daemon_stop_incomplete` with its loaded identity and source time. A refused stop retains its typed reason in the reload verdict.

Refresh a named participant with the same command and `--identity=<name>`, then verify the Stack again. A standalone daemon started with a separate home outside Stack commands is not registered with the Stack; its QA owner must refresh it separately. The Stack does not discover external homes or assume their lifecycle ownership.

For an exported-UI-only change, use `node ./apps/stack/scripts/repo_local.mjs stack build exp1 --web --runtime=source --json`. This follows the observed server host and replaces its served export through the existing publication owner, keeping the server and daemons running. Reload the browser after publication. These component commands report their own results; they do not run the full reload READY verification. `stack runtime activate --web|--server|--daemon` selects native artifact snapshots and does not restart running source components.

Source startup with `--ui=borrowed` skips the web export and uses the configured `HAPPIER_STACK_EXPO_SOURCE_STACK`. Setting the producer reference alone does not select borrowed UI. UI-only changes need a deliberate browser reload.

### Place QA browsers independently (0.3 development)

Set a browser pool without changing the stack's daemon placement:

```bash
node ./apps/stack/scripts/repo_local.mjs stack env exp1 set HAPPIER_STACK_QA_BROWSER_TARGETS=linux3,linux2
node ./apps/stack/scripts/repo_local.mjs dev-targets browser start qa1 --stack=exp1 --url=<qa-ui-url>
```

The browser selector compares current unreserved memory among those configured hosts for each browser lifetime. It writes no Machine pin and fails closed if no pool host is usable. When the browser setting is absent or empty, it retains the existing daemon-pool/default selection. Keep the foreground browser handle and interrupt it after QA to retire its browser, profile, and forwards. In 0.3 development, acquisition also requires a CDP WebSocket command response through the returned forward. A silent endpoint is retired after the default 30-second CDP attach window and replaced once before a handle is returned. Failed retirement stops acquisition; it never allocates a replacement beside an unconfirmed old browser. Loss of a managed browser's control channel also closes its browser and removes its owned temporary profile.

Browser IPC identities are bounded independently of the displayed lane name, so long lane names fit the macOS and Linux Unix socket limits. Launch and cleanup use the same internal identity. If both fail, the launch error remains primary and retains the cleanup error as its cause.

Host identity and memory observations run independently of heavyweight admission,
dependency preparation, and workspace synchronization. The exact read-only probes
use the executor's canonical observation policy; ordinary commands and browser
startup retain their source-readiness checks.

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

In current development source, placed Stack starts project this stack env file's explicit entries, including secrets, without printing values. Inherited shell/global entries are excluded; target placement, identity, storage and ports are preserved. The controller file is authoritative for operator settings: deleting an entry, including deleting every entry, removes its worker projection at the next placed Stack start/restart. Arbitrary target-only hand edits are removed too. Tool-generated auth-seed policy, runtime selection and managed-infrastructure settings (including database and object-storage credentials) remain worker-local; the retained names are defined beside the projection in `scripts/utils/dev_targets/remote_commands.mjs`. Explicit projected values still update those defaults. Daemon-only commands retain the existing env.

SQLite `DATABASE_URL=file:...` values belong to the host that owns the retained database and are not projected from the controller. The target keeps its existing local database URL. Network database URLs, including PostgreSQL URLs, remain explicit operator settings and are projected.

Known input-file settings (including `NODE_EXTRA_CA_CERTS`, scoped Git CA paths and `HAPPIER_MANAGED_NODE_BIN`) and `NODE_PATH` directories must be readable on the target; relative paths use its repository directory. Missing paths yield `remote_stack_env_path_unavailable` and stop lifecycle retries. A missing `HAPPIER_MANAGED_NODE_BIN` error names its configured target path and tells you to remove or correct the override in the controller stack env before starting again; it does not fall back to another runtime. Other file-setting failures name only the variable, keeping its value private. Provision files on the target and configure their target paths here; files are not copied.

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

In 0.3 development, `hstack stack info <stack> --json` includes `database` with
`provider`, `sharedSource`, `sourceStack`, `filesBackend`, and `basis`. A provider
with basis `loaded-source-bundle` or `loaded-runtime-snapshot` comes from the
observed loaded server's metadata. Shared-source selection and file storage
remain configured facts, identified separately by `sourceStackBasis` and
`filesBackendBasis` when the provider is loaded.
Stopped stacks report `configured` identity through the runtime's shared-source
resolver on the server host. Missing metadata or an unreachable authority reports
`unavailable` and a null provider; it does not attest the raw consumer setting.

For shared-database consumers, `stack env <stack> list` keeps the saved provider
line and adds an adjacent note naming the source stack and its configured
effective provider. These identity projections never include database connection
strings or source-stack private environment values.

In 0.3 development, `stack info` also shows a `sharedDatabase` section for a
shared-database consumer or a source with configured consumers. It names the
`sourceStack`, this stack's `role` (`source` or `consumer`), and the other
running server `coWriters`. Each row includes `stackName`, `role`, `host`,
`loadedSourceIdentity` (or `loadedSnapshotId` for a native runtime),
`startedAt`, `sourceTime`, and `staleCoWriter`.

The section has basis `local-stack-state`: it reads the existing local stack
inventory and recorded remote service observations, without probing peer
servers or querying the database. Remote rows therefore reflect the last
locally recorded observation. `host` is the recorded server target, or the
local hostname; `startedAt` is the recorded runtime start time.
`sourceTime` comes from the matching immutable source-bundle record's
`sourceCapture.capturedAt`, or a native snapshot manifest's `createdAt`. Remote source
times travel with the target's existing runtime identity observation; a
controller's completion record never supplies a remote runtime's time. A pending
selection is never substituted for the loaded identity. `staleCoWriter` is
`true` only when a different loaded identity has an earlier known source time;
it is `false` for identical identities or a known equal/newer source time,
and `null` when the comparison cannot be established from local metadata.
These are informational observations and do not gate or restart a stack.
An own-database stack with no configured consumers has no such section.

In 0.3 development, successful source reload preparation prints one `PREPARED`
line with UTC `sourceTime` values, each component's `rev` (`<sha>[+overlay:<digest>]`, or
`checkout` for a capture without a revision) and captured `inputIdentity` values for the prepared
server, daemon and exported UI on that host. This confirms replacement preparation and selection; retirement and
runtime startup can still be pending. Use `stack info` to confirm healthy running
components and matching selected/loaded identities before replaying work.
The existing `source-runtime/reload.json` record retains those per-component
values as `sourceTimes` and `sourceCaptures` (including `revision` and `overlayDigest`). `stack info` shows the reload result and the currently
loaded components' times; JSON includes each available time under
`runtime.sourceRuntimeIdentities.<component>.sourceTime`. Split runtimes keep
their own times. The capture time is recorded when the authored input copy finishes,
before compilation; reuse preserves that original time and identity. Later source
edits belong to the next reload and do not invalidate the captured build. Installed
dependencies remain shared and retain their dependency-publication checks. Older
completion records without capture metadata show an unknown capture time.
Retained remote observations produced by older tooling can still carry completion
times until the existing runtime observation is refreshed.

In 0.3 development, a shared-database consumer (SQLite or PostgreSQL) checks its
server's provider-specific migration catalog against the source database's completed,
non-rolled-back Prisma ledger before launching the server, including source reloads.
Missing migrations refuse startup with `ESHAREDDBMIGRATIONSMISSING`, the source stack
and missing names. The source stack's owner deploys them, or the migration author
reconciles retained development data under the repository's Compatibility rules;
the consumer never applies or repairs migrations. A source database ahead of the
consumer is accepted. Unavailable ledger/catalog access refuses with
`ESHAREDDBMIGRATIONSTATUSUNAVAILABLE`. This admission compares migration names,
not checksums or physical schema. Own-database stacks keep their existing migration
lifecycle. `stack info` remains an identity projection and does not query the ledger.

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

In 0.3 development, a remote source-snapshot or controlled daemon keeps its sign-in in the target's retained Stack home across controller restarts. A controller credential can seed that home, but its absence does not require another sign-in when the target is already authenticated. When authentication is missing, `stack info` reports `sign-in required`; sign in on the daemon host with `hstack stack happier <stack> --runtime -- auth login`. Readiness resumes without restarting the healthy services.

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

In 0.3 development, `hstack stack daemon <stack> stop` keeps that identity's
daemon stopped until an explicit `start` or `restart`. The stack's server and UI
keep running. Owner intent is retained in the existing `stack.runtime.json`,
so reinstalling the supervisor does not clear it. Unexpected daemon exits still
use normal crash recovery. `hstack stack info <stack>` reports
“daemon stopped by owner” for the default identity while it is stopped.
Commands follow the observed daemon host. Existing supervisors must load the
updated Stack tooling before this behavior is available.

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
