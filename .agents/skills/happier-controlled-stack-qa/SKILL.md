---
name: happier-controlled-stack-qa
description: Operate one dedicated, isolated, snapshot-backed Happier stack with explicit reload boundaries for stable QA. Use only when a user or human explicitly asks for a dedicated, controlled, stable, isolated, snapshot-backed, or manual-restart QA stack. Do not use merely because testing or QA was requested. Once invoked, reuse and remember the same QA stack throughout the current session unless the user explicitly requests multiple stacks or asks to replace it.
---

# Happier Controlled Stack QA

Use the existing named-stack and runtime-snapshot architecture. Do not create a QA-only runtime, wrapper command, build store, or mutable-state sharing path.

Canonical human documentation:

- `apps/docs/content/docs/hstack/stacks.mdx`, section “Controlled stacks for agent QA”
- `apps/docs/content/docs/hstack/running.mdx`, section “Runtime-backed named stacks”
- `apps/docs/content/docs/hstack/troubleshooting.mdx`, section “Runtime snapshots”

## Keep the entry policies separate

- Source validation is source-first: typechecks, ordinary tests, lint, and searches do not publish managed runtime artifacts, support closures, or snapshots.
- Source development may start from a valid last-green output while changed source outputs refresh in the background. For a checkout-derived repository producer, successful non-destructive server/daemon preparation requests the canonical publisher before the separately generation-fenced live activation: one publication may run at a time and later requests coalesce into one trailing identity recomputation. A newer edit may defer the source service restart without discarding useful completed bytes. The repository source owner is the only place allowed to advance a producer snapshot; a controlled consumer never starts a competing publisher.
- A full restart reconciliation compares web, server, and daemon identities. A failed publication keeps the current snapshot selected and source services unchanged, writes its phase through existing runtime state, and never restarts a consumer. An explicitly configured producer authority is not an automatic publisher.
- Managed publication builds only the component whose newer bytes are required, reuses unchanged owner-specific support artifacts, and commits a reference-only snapshot in the authority store.
- Generated bundled-plugin projections remain source-tree outputs: final serialized artifacts are prevalidated and published together through the existing mounted-tree transaction; known-invalid input fails before replacement, a caught commit failure rolls back, and the next canonical preflight repairs an interrupted replacement. This is not a generation-pointer, journal, or power-loss atomicity contract.
- Release/self-host packaging remains the existing per-target direct boundary: each builder materializes its own self-contained component/support payloads and does not consume or flatten a host-target managed snapshot.

## Checkout-bound invocation

For every command in this skill, run from the checkout under test through its existing local launcher:

```bash
node ./apps/stack/scripts/repo_local.mjs <hstack-subcommand> [args...]
```

Do not invoke a bare `hstack` from `PATH`: it can resolve a different checkout or installed toolchain. This is the existing launcher, not a new wrapper or alias; it binds the command to the checkout and prevents global re-exec.

Use the checkout launcher's canonical managed stack storage. Do not set `HAPPIER_STACK_STORAGE_DIR` to `.project/tmp`, another workspace folder, or an ad hoc writable directory merely to bypass an agent sandbox. A separate storage root is a separate stack universe: it cannot discover the repository build authority or approved auth sources and can trigger duplicate publication. If the sandbox cannot write the canonical managed storage root, request narrowly scoped write access for that root or report the controlled-stack setup as blocked. Do not work around it by creating a parallel stack root or manually copying credentials.

## Session stack invariant

Own exactly one controlled QA stack for the session unless the human explicitly requests multiple independent stacks.

1. At first use, inspect `node ./apps/stack/scripts/repo_local.mjs stack list --json` before creating anything.
2. Choose or reuse one stack pinned to the checkout under test. Prefer a stable purpose-revealing name such as `agent-qa-<session-or-lane>`.
3. State the chosen stack name in the next progress update and retain it as the session's current QA stack.
4. Reuse that exact name for every later build, activation, start, restart, status, doctor, auth, and stop command in the session.
5. After context compaction or uncertainty, recover the name from the conversation and `node ./apps/stack/scripts/repo_local.mjs stack list --json`/`node ./apps/stack/scripts/repo_local.mjs stack info <name> --json`. Do not create a replacement merely because the name was forgotten.
6. Create another stack only when the human explicitly asks for multiple stacks, a separate mutable-data lane, or replacement of the current stack. Name and track each authorized stack distinctly.

Never commandeer the human's development stack or another agent's mutable QA stack. Multiple stacks may share runtime snapshots, but they must not share SQLite, ports, CLI homes, daemon state, logs, or process ownership.

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
  --repo=/absolute/path/to/checkout \
  --server=happier-server-light \
  --db-provider=sqlite \
  --no-copy-auth \
  --non-interactive
```

Choose server flavor and database provider from the requested QA contract; do not copy or share another stack's database. Persist the controlled policy:

```bash
node ./apps/stack/scripts/repo_local.mjs stack env <qa-stack> set HAPPIER_STACK_RUNTIME_MODE=require
```

`require` is mandatory. It prevents source/watch fallback and makes `node ./apps/stack/scripts/repo_local.mjs stack dev <qa-stack>` fail instead of silently reintroducing hot reload.

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

## Select the UI provider

Default to the repository stack's already-running Expo/Metro endpoint. Do not start a consumer-owned Expo process and do not require the human to request the fast path separately.

The producer stack is human-owned infrastructure. Unless the human explicitly asks you to operate that producer, never run `dev`, `start`, `stop`, or `restart` against it. If its required server, daemon, or Expo endpoint is unavailable, report the producer prerequisite and continue only the consumer work that remains valid; do not recover the producer by taking over its lifecycle.

Resolve the producer from the managed stacks already pinned to this checkout, then verify it before persisting the reference:

```bash
node ./apps/stack/scripts/repo_local.mjs stack list --json
node ./apps/stack/scripts/repo_local.mjs stack info <producer-stack> --json
node ./apps/stack/scripts/repo_local.mjs stack env <qa-stack> set HAPPIER_STACK_EXPO_SOURCE_STACK=<producer-stack>
```

Use strict snapshot UI instead only when the human explicitly requests frozen/reproducible UI bytes, requests no shared Expo, or the QA contract does not exercise the live UI. If the intended producer is unreachable or has no Expo endpoint, report that prerequisite; do not silently start a competing local Expo or change UI modes.

## Select and start

First inspect the repository runtime producer already pinned to this checkout. Then select its active snapshot for the remembered consumer:

```bash
node ./apps/stack/scripts/repo_local.mjs stack info <producer-stack> --json
node ./apps/stack/scripts/repo_local.mjs stack runtime <qa-stack> select --json
```

`select` validates the producer's current complete snapshot and writes only the consumer's selection; it does not change the consumer's launch mode. It does not build, publish, activate, restart, or otherwise mutate that producer. The checkout-pinned repository authority remains the sole build owner; do not set up another build store, monitor, or fallback producer.

If the producer's active snapshot already contains the bytes under test, select and reuse it. Do not build merely because the controlled stack is new.

When current server or daemon bytes are required, request them through the remembered consumer stack. The command resolves the repository authority, joins the shared publication queue, and reuses the newest compatible publication when it becomes available. Explicit snapshot ids remain exact pins. Artifacts are written only in the authority store:

```bash
node ./apps/stack/scripts/repo_local.mjs stack build <qa-stack> --server --daemon --json
node ./apps/stack/scripts/repo_local.mjs stack runtime <qa-stack> activate --all --json
```

If the shared publication fails (for example, another program's in-flight compile error in the moving checkout), do not retry in a loop or build elsewhere. Keep QA on the last complete snapshot that the consumer can select, record the snapshot id and the publication failure, and mark any evidence that needs the newer bytes as blocked on publication.

A live publication may exclude a broken optional bundled plugin and still succeed. The daemon catalog then shows that plugin as a disabled `load_error` row carrying its build diagnostic, while required plugins still fail publication. Before attributing a missing plugin surface to a product defect, check the catalog diagnostic and record excluded plugins with the result.

Use only the changed component flag when narrower (`--server` or `--daemon`). `runtime activate --all` composes the latest authority artifacts into one complete snapshot and selects it for the consumer; it does not restart the consumer or the producer's running services. Run one build request and wait for it. Do not launch retrying publishers, a second monitor-owned build, another artifact store, or a direct build against the human's producer lifecycle.

Borrowed Expo does not need a new web build. Managed server and web artifacts are independent: a server-only request publishes server code/support without a web export. Strict snapshot UI requires an explicit `--web` request. Runtime snapshots reference canonical producer payloads and managed support references are dev/QA-only; release/self-host packaging uses its existing per-target self-contained builders directly and does not consume or flatten a managed snapshot.

Selecting a snapshot does not restart a running consumer.

Start the default borrowed-Expo stack from built server/daemon bytes. The `start` process is the stack's long-lived lifecycle owner, so use Stack's detached background mode when no TUI is needed:

```bash
node ./apps/stack/scripts/repo_local.mjs stack start <qa-stack> --background --runtime --no-browser
```

Use `node ./apps/stack/scripts/repo_local.mjs tui stack start <qa-stack> --runtime --mobile` when operating an interactive TUI. Do not stop or restart a human-owned TUI to obtain this stack. A still-running foreground start is expected; it is not evidence of a hang.

Before relying on QA results, inspect:

```bash
node ./apps/stack/scripts/repo_local.mjs stack info <qa-stack> --json
node ./apps/stack/scripts/repo_local.mjs stack doctor <qa-stack> --runtime
node ./apps/stack/scripts/repo_local.mjs stack happier <qa-stack> --runtime -- <cli-args...>
```

Keep `--runtime` on every `stack happier` command for the controlled stack. It runs the selected snapshot's CLI and bypasses source-workspace freshness publication. Omit it only when intentionally testing the checkout's source CLI outside this controlled-runtime workflow.

Record these runtime facts with the result:

- `runtime.selectedProducerStackName`
- `runtime.selectedSnapshotId`
- `runtime.loadedSnapshotId`
- `runtime.pendingManualRestart`

Do not claim runtime-backed QA unless the loaded snapshot identity is observed.

## Cross the reload boundary deliberately

After the needed snapshot is published, select it without disrupting the running consumer:

```bash
node ./apps/stack/scripts/repo_local.mjs stack runtime <qa-stack> select
node ./apps/stack/scripts/repo_local.mjs stack info <qa-stack> --json
```

While the older runtime remains loaded, expect `pendingManualRestart=true`. Continue the current QA flow or restart only when the test operator intends to load the new selection.

Use the existing TUI `r` action, the stack service restart, or an explicit `start --restart`. Re-inspect status and require selected and loaded snapshot ids to match before attributing new QA evidence to the current source change.

For a component-only change, keep the ownership boundary intact:

- UI-only with borrowed Expo: manually reload the browser; it receives the producer's current bundle. Do not build a consumer web artifact.
- Server or daemon: run the matching `stack build <qa-stack> --server|--daemon`, then `stack runtime <qa-stack> activate --all`. The checkout authority coalesces publication; the consumer owns only its selection and explicit restart boundary.
- Strict snapshot UI: run `stack build <qa-stack> --web`, then `stack runtime <qa-stack> activate --all` before selecting/restarting as needed.

Selection is non-disruptive. Restart before claiming a server or daemon change is loaded.

## Operate the UI mode

### Default: fast controlled-live Expo

With the producer reference already configured, use the detached `stack start --background --runtime --no-browser` command above. For an interactive TUI, use:

```bash
node ./apps/stack/scripts/repo_local.mjs tui stack start <qa-stack> --runtime --mobile
```

The producer remains Expo's sole lifecycle owner. Even with `--mobile`, the consumer must not start, restart, stop, or locally replace Expo. Its TUI may display the producer's local or remote tee log.

For browser QA, use the generated consumer-origin URL with its consumer `server` parameter and `happier_hmr=0`. The page updates only when manually reloaded, at which point it receives the producer's latest bundle. Describe this as controlled-live, never immutable.

Installed native development clients may use the advertised or tunnelled producer Metro endpoint, but `happier_hmr=0` does not disable native Fast Refresh.

If borrowed Expo is degraded, diagnose the producer and consumer. Do not create a competing local Expo. Switch to strict snapshot UI only when that serves the requested QA contract; otherwise report the blocked UI prerequisite.

Stability against a moving development stack comes from the controlled-live mode itself. Server and daemon run from the selected snapshot and never hot-reload. For the UI:
1. Open the consumer URL with `happier_hmr=0` once.
2. Keep that tab for the whole QA round, and warm the routes you will exercise: lazy chunks come from the producer's Metro, so a route opened for the first time while producer Expo restarts can fail.
3. Reload deliberately only when you want the producer's newer UI, then record it.

Strict snapshot UI is not the default answer to churn. A web artifact is content-addressed by UI source fingerprint and reused by every consumer that selects that snapshot. But in a moving checkout nearly every UI edit needs a fresh full `expo export`, which costs minutes and substantial memory. Use it when producer Expo is unavailable or keeps crashing for the duration of the round, or when exact reproducible UI bytes are required. Record the UI mode in the handoff.

### Explicit strict snapshot UI

Use the selected snapshot's static UI when the human explicitly requests exact/reproducible UI bytes:

```bash
node ./apps/stack/scripts/repo_local.mjs stack env <qa-stack> unset HAPPIER_STACK_EXPO_SOURCE_STACK
node ./apps/stack/scripts/repo_local.mjs tui stack start <qa-stack> --runtime
```

## Remote placement boundary (0.3 development)

The current `stack start --runtime` owner loads the consumer's snapshot locally; it does not consume `dev-targets` service placement. The remote supervisor currently runs `stack dev --watch`. Do not substitute that source lifecycle for a controlled snapshot or interpret a placement config write as a service or data move.

Before a controlled stack can move, its canonical placement/runtime owners must transfer and validate the selected snapshot's complete component/support closure, preserve the retained server-light directory (database, signing secret, public and private files), isolate the target CLI state per stack, and provide a writable session workspace outside the one-way source replica. Preserve the consumer's canonical server origin and browser state through the existing forwards. Observe selected == loaded for the actual remote server and daemon before claiming the pin is running there.

Managed snapshots are target-specific: compare the manifest's platform/architecture with the target's observed host identity. WSL is a Linux target, but its architecture must still match. An ARM64 snapshot cannot be used on an x64 worker by copying files or changing its manifest. If the requested worker cannot load the producer's pin, report the target choice or producer-publication decision instead of starting a consumer publisher. A placement change must use the canonical retained-data handoff; never copy a live SQLite file manually or initialize a replacement database to make remote startup pass.

## Preserve ownership and evidence

- Stop only the remembered consumer with `node ./apps/stack/scripts/repo_local.mjs stack stop <qa-stack>`; this must not stop borrowed Expo.
- Keep the stack for reuse throughout the session. Do not delete/recreate it between scenarios to obtain fresh state unless the human explicitly requests that reset or a separate stack.
- Stop it when idle. When a QA session or round ends and no further QA on this stack is imminent, stop the remembered consumer with the `stack stop` command above. Each idle stack holds a server and a daemon (several GB of memory), and the shared machine runs many programs' stacks at once. The next round re-selects the snapshot and starts it again through "Select and start"; the stack name, database and auth are retained, so stopping loses nothing. Never stop another session's or program's stack.
- Never delete, replace, or share its database without the normal authorization required for that exact data owner.
- Do not treat selecting a snapshot, a still-running process, or wiring registration as proof that new bytes loaded.
- Report the stack name, loaded snapshot id, UI mode, terminal QA result, skipped checks, and residual risk in the handoff.
- Each controlled stack runs its own server and daemon on the authoritative machine. Heavy source validation (tests, typechecks, broad searches) still follows `.agents/skills/happier-remote-work` and routes through `hstack-exec`. Do not run it locally just because a QA stack is local.
