---
name: happier-controlled-stack-qa
description: Operate one dedicated, isolated, snapshot-backed Happier stack with explicit reload boundaries for stable QA. Use only when a user or human explicitly asks for a dedicated, controlled, stable, isolated, snapshot-backed, or manual-restart QA stack. Do not use merely because testing or QA was requested. Once invoked, reuse and remember the same QA stack throughout the current session unless the user explicitly requests multiple stacks or asks to replace it.
---

# Happier Controlled Stack QA

Use the existing named-stack lifecycle with direct source bundles. In 0.3 development, new QA stacks default to `source-snapshot`: bundle the executing host's synced source mirror, run the emitted JS without watchers, and rebuild only at an explicit restart. Source QA does not publish, select, stage or demand native runtime snapshots. `--runtime=built` is a separate opt-in for already-built runtime outputs. Mutable-data sharing uses only the explicit preset below when authorized.

Canonical human documentation:

- `apps/docs/content/docs/hstack/stacks.mdx`, section “Controlled stacks for agent QA”
- `apps/docs/content/docs/hstack/running.mdx`, section “Runtime-backed named stacks”
- `apps/docs/content/docs/hstack/troubleshooting.mdx`, section “Runtime snapshots”

## Keep the entry policies separate

- Source validation remains source-first; run tests, typechecks and searches through `hstack-exec`, not QA startup.
- Source QA resolves first-party source exports and bundles server/CLI code directly. It reuses the host's installed dependencies/native support; no package dist preparation or typecheck belongs in this path.
- Normal development and explicit built-runtime publication are separate workflows. Never operate the human's producer lifecycle to make a QA bundle.
- Generated plugin declarations retain their canonical owner and declared-id admission. A failed bundle is a failed start, not permission to omit plugins or fall back to the moving mirror.
- Source bundles are development execution, not release artifacts or certification representations.

## Checkout-bound invocation

For every command in this skill, run from the checkout under test through its existing local launcher:

```bash
node ./apps/stack/scripts/repo_local.mjs <hstack-subcommand> [args...]
```

Do not invoke a bare `hstack` from `PATH`: it can resolve a different checkout or installed toolchain. This is the existing launcher, not a new wrapper or alias; it binds the command to the checkout and prevents global re-exec.

Use the checkout launcher's canonical managed stack storage. Do not set `HAPPIER_STACK_STORAGE_DIR` to `.project/tmp`, another workspace folder, or an ad hoc writable directory merely to bypass an agent sandbox. A separate storage root is a separate stack universe: it cannot discover retained stack identity, lifecycle or approved auth sources. If the sandbox cannot write the canonical managed storage root, request narrowly scoped write access for that root or report setup as blocked. Do not create a parallel stack root or manually copy credentials.

## Session stack invariant

Own exactly one controlled QA stack for the session unless the human explicitly requests multiple independent stacks.

1. At first use, inspect `node ./apps/stack/scripts/repo_local.mjs stack list --json` before creating anything.
2. Choose or reuse one stack pinned to the checkout under test. Prefer a stable purpose-revealing name such as `agent-qa-<session-or-lane>`.
3. State the chosen stack name in the next progress update and retain it as the session's current QA stack.
4. Reuse that exact name for every later build, activation, start, restart, status, doctor, auth, and stop command in the session.
5. After context compaction or uncertainty, recover the name from the conversation and `node ./apps/stack/scripts/repo_local.mjs stack list --json`/`node ./apps/stack/scripts/repo_local.mjs stack info <name> --json`. Do not create a replacement merely because the name was forgotten.
6. Create another stack only when the human explicitly asks for multiple stacks, a separate mutable-data lane, or replacement of the current stack. Name and track each authorized stack distinctly.

Never commandeer the human's development stack or another agent's mutable QA stack. Explicit built stacks may share runtime snapshots; source stacks retain their own emitted JS. SQLite and blob sharing requires the explicit shared-development-database preset below and human authorization; ports, CLI homes, daemon state, logs, and process ownership stay separate.

## Establish the controlled stack

Resolve the absolute checkout path and inspect existing state:

```bash
pwd -P
node ./apps/stack/scripts/repo_local.mjs stack list --json
node ./apps/stack/scripts/repo_local.mjs stack info <qa-stack> --json
```

If the remembered stack does not exist, create it once:

```bash
node ./apps/stack/scripts/repo_local.mjs stack new <qa-stack> \
  --qa \
  --repo=/absolute/path/to/checkout \
  --server=happier-server-light \
  --db-provider=sqlite \
  --no-copy-auth \
  --non-interactive
```

Choose server flavor and database provider from the requested QA contract. Keep data isolated unless the human explicitly requests the shared-development-database preset below. Persist the controlled policy:

```bash
node ./apps/stack/scripts/repo_local.mjs stack env <qa-stack> set HAPPIER_STACK_RUNTIME_MODE=source-snapshot
```

`--qa` sets this default on new stacks. Set it explicitly when adopting a retained stack; never use `stack dev` for controlled QA. `--runtime=source` selects the same no-watch source mode for one invocation. Use `--runtime=built` only when deliberately testing existing built output.

Generic `stack new` inherits auth from `main` unless told otherwise. `--no-copy-auth` is mandatory here so that a controlled stack has no unapproved credential provenance.

For a fresh QA-local Account, leave the new stack unseeded until its selected runtime is started. Create the Account in that stack's web UI, then run guided CLI login against the same stack:

```bash
node ./apps/stack/scripts/repo_local.mjs stack auth <qa-stack> login --no-open
node ./apps/stack/scripts/repo_local.mjs stack auth <qa-stack> status --json
```

Approve the login link in the QA web session and require `auth.ok: true` from status before CLI or daemon QA. `login --print --json` only prints the underlying command; it does not mint credentials. Do not record the link or token in reports or logs.

If the QA contract calls for an existing Account instead, seed only from a human-approved source:

```bash
node ./apps/stack/scripts/repo_local.mjs stack auth <human-approved-source> -- status --json
node ./apps/stack/scripts/repo_local.mjs stack auth <qa-stack> -- copy-from <human-approved-source>
```

Proceed only when the source reports `auth.ok: true`. If it does not, stop and obtain human direction to reauthenticate that source or approve a different source; do not retry, delete auth files, or recreate either stack.

If the stack was created without `--no-copy-auth`, do not delete auth files or recreate it. `--force` is not a broad recovery mechanism: it replaces target auth files only after Account seeding proves the target data compatible, and it rejects conflicting target Account rows. Use it only after human approval of the same source and target; otherwise re-authenticate the approved source or obtain direction.

After that approval, replace only the target seed:

```bash
node ./apps/stack/scripts/repo_local.mjs stack auth <qa-stack> -- copy-from <human-approved-source> --force
```

Auth seeding does not authorize database sharing or destructive database reconciliation. A SQLite source database is read without mutating or reconciling its migration ledger.

## Explicit shared-development-database QA (0.3 development)

Use this only when the human requests shared development data. Apply it to the remembered fresh SQLite stack before starting it:

The shared-database workflow is not yet live-certified. Confirm that its source env resolves the running development server's database, not another retained database on the same host; pause on an authority/path conflict rather than starting QA against the other copy.

```bash
node ./apps/stack/scripts/repo_local.mjs stack env <qa-stack> shared-db <dev-stack> --json
```

The preset pins the QA server to the dev database's explicitly configured remote host. New `--qa` stacks (and new `agent-qa-*` stacks) request the configured linux3, linux2 and linux1 pool. The service-placement owner observes each reachable host and chooses the greatest actually available memory after live admission reservations, once, then persists an explicit daemon pin before runtime selection. Resident Expo, browser and daemon memory is already reflected in available memory; it is not subtracted twice. Source-build admission is separate and may queue on the pinned host. Windows1 is excluded until its outer Windows C: disk health is established; WSL guest free space is not that evidence. That daemon is the Machine identity that owns sessions, resume and workspaces: later QA/command pool changes cannot move it, and an unavailable pin fails closed. Existing stacks retain their placement until their owner explicitly changes it at the next restart. The server reads the dev stack's existing SQLite URL, at-rest secret, and blob roots on that host. Never print or transport the secret. QA keeps its own data/runtime directory, ports, CLI home, daemon state, and logs. Metrics are disabled, automatic migration is off, and Stack migration is skipped. Never migrate, reset, reconcile, or restart the dev database/server to recover QA.

All Accounts and sessions live in the same database, with normal Account authorization unchanged. A new QA Account does not inherit the dev Account's connected services: sign into the dev Account only when authorized and needed to test those services. Separate servers do not share their in-memory socket/RPC relay; do not assume live cross-server delivery to a daemon connected to the other server.

Start source QA directly on the existing data and daemon hosts:

```bash
node ./apps/stack/scripts/repo_local.mjs stack start <qa-stack> --background --runtime=source --no-browser
```

The shared preset retains the server's data host and the daemon's fixed Machine. Each host bundles its own mirror and uses its installed native support; JS source code is not a native-target snapshot. CLI/auth on the controller uses its own direct source CLI bundle without changing remote runtime identities. If the schema advances beyond loaded QA code, P2021/P2022 report `shared_qa_schema_mismatch`; explicitly restart only this QA stack to rebundle. QA never migrates the shared database.

## Select the UI provider

Source QA defaults to a one-shot source web export on its server host, served by that server. The canonical plugin UI projection is prepared privately from source, without native publication or shared generated-output writes. The existing Expo cache/state owner uses the stable Stack source root, while each export gets a fresh private output; cache reuse never mutates a previous frozen web output. There is no resident Metro or hot reload; an explicit Stack restart rebuilds the export. Use the reported QA UI URL, not the producer's Expo URL.

Borrow moving Expo only when explicitly requested with `--ui=borrowed`. A configured producer reference alone does not select it. `--no-ui` requests a headless source worker.

The producer stack is human-owned infrastructure. Unless the human explicitly asks you to operate that producer, never run `dev`, `start`, `stop`, or `restart` against it. If its required server, daemon, or Expo endpoint is unavailable, report the producer prerequisite and continue only the consumer work that remains valid; do not recover the producer by taking over its lifecycle.

Resolve the producer from the managed stacks already pinned to this checkout, then verify it before persisting the reference:

```bash
node ./apps/stack/scripts/repo_local.mjs stack list --json
node ./apps/stack/scripts/repo_local.mjs stack info <producer-stack> --json
node ./apps/stack/scripts/repo_local.mjs stack env <qa-stack> set HAPPIER_STACK_EXPO_SOURCE_STACK=<producer-stack>
```

If an explicitly borrowed producer is unreachable or has no Expo endpoint, report that prerequisite; do not silently start a competing local Expo or change UI modes. The source export default does not depend on that producer.

## Start direct source QA

The `start` process remains the stack's long-lived lifecycle owner. It synchronizes before remote dispatch, bundles once on each actual runtime host, and starts managed JS without watchers. Use detached background mode when no TUI is needed:

```bash
node ./apps/stack/scripts/repo_local.mjs stack start <qa-stack> --background --runtime=source --no-browser
```

Use `node ./apps/stack/scripts/repo_local.mjs tui stack start <qa-stack> --runtime=source` for an interactive TUI, adding `--ui=borrowed --mobile` only for explicitly borrowed Expo. Do not stop or restart a human-owned TUI. A still-running foreground start is expected; it is not evidence of readiness or a hang.

Before relying on QA results, inspect:

```bash
node ./apps/stack/scripts/repo_local.mjs stack info <qa-stack> --json
node ./apps/stack/scripts/repo_local.mjs stack doctor <qa-stack>
node ./apps/stack/scripts/repo_local.mjs stack happier <qa-stack> --runtime=source -- <cli-args...>
```

`stack happier --runtime=source` uses the retained emitted CLI bundle, preparing it directly if absent. It does not request native publication. Do not use bare `--runtime`, which is the older built-runtime selector.

Record these runtime facts with the result:

- `runtime.mode` (`source-snapshot`)
- `runtime.sourceRuntimeIdentities.server.selected` and `.loaded`
- `runtime.sourceRuntimeIdentities.daemon.selected` and `.loaded`
- actual role readiness and host placement

Require each requested role's nonempty selected identity to equal its loaded identity. Root state alone is insufficient if remote custody or the actual service is not running. Missing identities/readiness block live evidence; they never authorize fallback to watchers.

## Cross the reload boundary deliberately

Moving source edits do not change emitted QA code. To load newer code, deliberately rebuild and restart only the remembered stack:

```bash
node ./apps/stack/scripts/repo_local.mjs stack start <qa-stack> --background --runtime=source --restart --no-browser
node ./apps/stack/scripts/repo_local.mjs stack info <qa-stack> --json
```

Re-inspect status and require per-role selected == loaded before attributing new QA evidence to this restart. Record start-to-ready and reload-to-ready timings separately. UI-only with borrowed Expo requires a deliberate browser reload, not a server/daemon bundle or native web build.

## Explicit built QA

When the human asks to test an existing built runtime, use `stack runtime <qa-stack> select` if selection is needed, then `stack start <qa-stack> --background --runtime=built --no-browser`. Require native `runtime.selectedSnapshotId == runtime.loadedSnapshotId` and the actual role readiness. A missing target-compatible built output is a prerequisite, not permission to route source QA through publication/flight/demand/staging machinery. Built mode does not define source bundle representation or reload.

## Operate the UI mode

### Explicit option: controlled-live Expo

With the producer reference already configured, use the detached source start above. For an interactive TUI, use:

```bash
node ./apps/stack/scripts/repo_local.mjs tui stack start <qa-stack> --runtime=source --ui=borrowed --mobile
```

The producer remains Expo's sole lifecycle owner. Even with `--mobile`, the consumer must not start, restart, stop, or locally replace Expo. Its TUI may display the producer's local or remote tee log.

For browser QA, use the generated consumer-origin URL with its consumer `server` parameter and `happier_hmr=0`. The page updates only when manually reloaded, at which point it receives the producer's latest bundle. Describe this as controlled-live, never immutable.

Installed native development clients may use the advertised or tunnelled producer Metro endpoint, but `happier_hmr=0` does not disable native Fast Refresh.

If borrowed Expo is degraded, diagnose the producer and consumer. Do not create a competing local Expo. Return to the source export default only through an explicit restart without `--ui=borrowed`, or report the blocked UI prerequisite.

Server and daemon run from retained source bundles (or explicitly selected built output) and never hot-reload. Borrowed UI has a weaker, moving-source boundary:
1. Open the consumer URL with `happier_hmr=0` once.
2. Keep that tab for the whole QA round, and warm the routes you will exercise: lazy chunks come from the producer's Metro, so a route opened for the first time while producer Expo restarts can fail.
3. Reload deliberately only when you want the producer's newer UI, then record it.

Source QA's default server, daemon and one-shot web export remain unchanged until explicit restart. Borrowed Expo is explicitly moving UI, including lazy chunks; HMR off is not proof of frozen UI. The source export path prepares its own canonical plugin UI projection and does not build or select a native runtime snapshot.

### Explicit strict snapshot UI

Use the selected snapshot's static UI when the human explicitly requests exact/reproducible UI bytes:

```bash
node ./apps/stack/scripts/repo_local.mjs stack env <qa-stack> unset HAPPIER_STACK_EXPO_SOURCE_STACK
node ./apps/stack/scripts/repo_local.mjs tui stack start <qa-stack> --runtime=built
```

## Remote placement boundary (0.3 development)

`stack start --runtime=source` resolves runtime placement through the existing dev-targets config and service-placement owners. New QA stacks compare current unreserved available memory across `HAPPIER_STACK_QA_DAEMON_TARGETS` (default linux3,linux2,linux1) and persist the best host as one explicit daemon pin. Equal budgets retain configured pool order. No validation-memory floor controls pin selection; source-build admission owns its measured envelope separately. Windows1 is not in the default pool while outer Windows C: health is unverified. Subsequent starts never reselect that Machine. Retained local server data stays local until explicit handoff; shared-DB QA keeps its server on the data host. Unhealthy synchronization prevents dispatch. Configure runtime placement in the same config; source bundling runs on each actual runtime host, independently of build-pool placement:

```bash
node ./apps/stack/scripts/repo_local.mjs dev-targets placement set daemon mac3-linux --stack=<qa-stack>
node ./apps/stack/scripts/repo_local.mjs dev-targets placement set daemon local --stack=<qa-stack>
node ./apps/stack/scripts/repo_local.mjs dev-targets placement set qa local --stack=<qa-stack>
```

An explicit QA server override can use the existing least-load or ordered selector. It never overrides Machine placement. A pinned daemon host fails closed when unavailable, preserving session/workspace identity. Persisted remote server data also remains authoritative even with a local QA override. Do not alter the producer's existing placement merely to run one QA session without the necessary authority.

The existing supervisor flushes the host mirror and launches `stack start --runtime=source --no-dev-targets`, not source watch or native archive transfer. CLI state and writable session workspaces are per-stack outside the one-way replica. Existing forwards preserve the consumer's canonical server origin. Observe per-role source selected == loaded for the actual remote server and daemon before claiming the pin is running there.

Only explicit built mode is native-target-specific: its manifest must match the observed host OS/architecture. Never copy an ARM64 snapshot onto x64 or edit its manifest to claim a match. Source JS instead reuses each runtime host's own native dependencies.

### Browser on the fixed QA host

Dedicated QA browsers launch with `--no-sandbox` at the canonical `qa_browser.mjs` owner, per the approved QA-host policy. Use them only for Happier's own QA app; Playwright attaches to that existing browser rather than launching another one.

Provision the selected host with `dev-targets qa setup <target> --stack=<qa-stack>`. This uses managed JS/Agent installers and the existing browser, power and disk-retention owners. Do not copy user Agent credentials; the daemon materializes the Account's connected services.

Start `dev-targets browser start <lane-session> --stack=<qa-stack> --url=<qa-ui-url>` in a retained TTY-backed foreground tool handle. Non-TTY tool cancellation can terminate only the checkout launcher, leaving the actual command and forward alive; cancellation alone is not cleanup evidence. The service-placement owner selects the configured QA pool host with the greatest actually available memory after live reservations for this browser lifetime, independently of the daemon's host and without initializing or changing daemon placement. It returns a loopback CDP endpoint plus the browser-facing `url` with its original origins intact. A lane-owned loopback reverse SOCKS route reaches the controller's QA server and borrowed Expo ingress, so canonical Home addresses remain reachable after restore. The browser owner supplies the proxy policy; do not rewrite the Home URL or add per-lane flags. Open that returned URL through controller-local `agent-browser --session <lane-session> --cdp <endpoint> open <returned-url>` or Playwright `connectOverCDP`. Keep the same handle and browser profile for the QA round. End the handle with SIGINT and verify its terminal cleanup before stopping the owned stack. Never stop another lane's browser.

An unusable QA pool or unavailable selected browser host fails closed; never fall back to a controller-local browser or relocate the Machine. An unavailable daemon pin still prevents daemon startup but does not force the browser onto that host. The browser pool uses `HAPPIER_STACK_QA_DAEMON_TARGETS`, defaulting to linux3, linux2 and linux1; Windows1 stays excluded while its outer Windows C: health is unverified. Browser selection writes no persistent pin. Existing stacks move only when their owner stops them and runs `dev-targets placement set daemon <chosen-host> --stack=<qa-stack>` before their next explicit restart. Verify current unreserved memory and host readiness across the configured QA pool first; do not proactively move a running stack. Heavy validation stays in its separate eligible build pool. Do not change the development stack's daemon placement.

For retained local light-server data, first stop only this consumer, then use `dev-targets move-server <target> --stack=<qa-stack>`. This canonical explicit operation copies the full server directory, verifies checksums and SQLite integrity, retains the local source, and commits placement only after verification. It rejects a running stack, conflicting target data, and unsupported layouts. An already-remote stack stays on its data host. Never copy a live SQLite file manually, remove the retained source, or initialize a replacement database to make remote startup pass.

## Preserve ownership and evidence

- Stop only the remembered consumer with `node ./apps/stack/scripts/repo_local.mjs stack stop <qa-stack>`; this must not stop borrowed Expo.
- Keep the stack for reuse throughout the session. Do not delete/recreate it between scenarios to obtain fresh state unless the human explicitly requests that reset or a separate stack.
- Stop it when idle. The next round starts the same stack and bundles its current host mirrors; its database and auth remain retained. Never stop another session's or program's stack.
- Never delete, replace, or share its database without the normal authorization required for that exact data owner.
- Do not treat selecting a snapshot, a still-running process, or wiring registration as proof that new bytes loaded.
- Report the stack name, per-role loaded source identities (or explicit built snapshot id), UI mode, terminal QA result, skipped checks, and residual risk in the handoff.
- Each controlled stack runs its own server and daemon on the authoritative machine. Heavy source validation (tests, typechecks, broad searches) still follows `.agents/skills/happier-remote-work` and routes through `hstack-exec`. Do not run it locally just because a QA stack is local.
