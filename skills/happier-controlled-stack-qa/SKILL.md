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

Seed authentication only when needed and from a human-approved source:

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

Use only the changed component flag when narrower (`--server` or `--daemon`). `runtime activate --all` composes the latest authority artifacts into one complete snapshot and selects it for the consumer; it does not restart the consumer or the producer's running services. Run one build request and wait for it. Do not launch retrying publishers, a second monitor-owned build, another artifact store, or a direct build against the human's producer lifecycle.

Borrowed Expo does not need a new web build. Managed server and web artifacts are independent: a server-only request publishes server code/support without a web export. Strict snapshot UI requires an explicit `--web` request. Runtime snapshots reference canonical producer payloads and managed support references are dev/QA-only; release/self-host packaging uses its existing per-target self-contained builders directly and does not consume or flatten a managed snapshot.

Selecting a snapshot does not restart a running consumer.

Start the default borrowed-Expo stack from built server/daemon bytes:

```bash
node ./apps/stack/scripts/repo_local.mjs tui stack start <qa-stack> --runtime --mobile
```

Use `node ./apps/stack/scripts/repo_local.mjs stack start <qa-stack> --runtime --no-browser` when a TUI is inappropriate. Do not stop or restart a human-owned TUI to obtain this stack.

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

Use the existing TUI `r` action, the stack service restart, or an explicit `start --restart`. Re-inspect status and require selected and loaded snapshot ids to match before attributing new QA evidence to the candidate.

For a component-only change, keep the ownership boundary intact:

- UI-only with borrowed Expo: manually reload the browser; it receives the producer's current bundle. Do not build a consumer web artifact.
- Server or daemon: run the matching `stack build <qa-stack> --server|--daemon`, then `stack runtime <qa-stack> activate --all`. The checkout authority coalesces publication; the consumer owns only its selection and explicit restart boundary.
- Strict snapshot UI: run `stack build <qa-stack> --web`, then `stack runtime <qa-stack> activate --all` before selecting/restarting as needed.

Selection is non-disruptive. Restart before claiming a server or daemon change is loaded.

## Operate the UI mode

### Default: fast controlled-live Expo

With the producer reference already configured, use:

```bash
node ./apps/stack/scripts/repo_local.mjs tui stack start <qa-stack> --runtime --mobile
```

The producer remains Expo's sole lifecycle owner. Even with `--mobile`, the consumer must not start, restart, stop, or locally replace Expo. Its TUI may display the producer's local or remote tee log.

For browser QA, use the generated consumer-origin URL with its consumer `server` parameter and `happier_hmr=0`. The page updates only when manually reloaded, at which point it receives the producer's latest bundle. Describe this as controlled-live, never immutable.

Installed native development clients may use the advertised or tunnelled producer Metro endpoint, but `happier_hmr=0` does not disable native Fast Refresh.

If borrowed Expo is degraded, diagnose the producer and consumer. Do not create a competing local Expo. Switch to strict snapshot UI only when that serves the requested QA contract; otherwise report the blocked UI prerequisite.

### Explicit strict snapshot UI

Use the selected snapshot's static UI when the human explicitly requests exact/reproducible UI bytes:

```bash
node ./apps/stack/scripts/repo_local.mjs stack env <qa-stack> unset HAPPIER_STACK_EXPO_SOURCE_STACK
node ./apps/stack/scripts/repo_local.mjs tui stack start <qa-stack> --runtime
```

## Preserve ownership and evidence

- Stop only the remembered consumer with `node ./apps/stack/scripts/repo_local.mjs stack stop <qa-stack>`; this must not stop borrowed Expo.
- Keep the stack for reuse throughout the session. Do not delete/recreate it between scenarios to obtain fresh state unless the human explicitly requests that reset or a separate stack.
- Never delete, replace, or share its database without the normal authorization required for that exact data owner.
- Do not treat selecting a snapshot, a still-running process, or wiring registration as proof that new bytes loaded.
- Report the stack name, loaded snapshot id, UI mode, terminal QA result, skipped checks, and residual risk in the handoff.
