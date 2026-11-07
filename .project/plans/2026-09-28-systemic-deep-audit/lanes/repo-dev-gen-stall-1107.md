Status: BLOCKED — incident root cause remains inconclusive; no production fix is justified yet.

# repo-dev-gen-stall-1107

The retained evidence locates the stall inside an admitted source-build tree, but does not identify the pending operation. No timeout, lifecycle wrapper, restart, dependency change, or database mutation was introduced. Systemic has been asked for the actual build-phase log or a pending-stack capture on recurrence.

## Observed evidence

- The supplied snapshot is `.project/tmp/repo-dev-gen-stall-1107/`: `process-tree.txt` has 23 lines, `fds.txt` 107, and `runner-tail.log` 400.
- The snapshot records worker 4157547 in `ep_poll`, with services 800334 and 4158580 in `futex_wait_queue`. These are thread wait locations, not proof of a native deadlock or lost IPC.
- `fds.txt:39` records the build lock held by 4155597. The worker retains service sockets at lines 96–101; the snapshot does not include their peer/native pending stacks or JS promise stacks.
- A whitelist-only inspection of the 400-line runner tail found zero `watch:`, `source-bundle`, `happier-cli changed`, `source generation`, `generation`, or `dependency` markers. It cannot establish the build's last completed phase.
- A PID/status-only query found none of the six recorded worker/service PIDs still present. The original wait can no longer be inspected live.
- The canonical read-only repo identity resolves to `repo-dev-a1cc5e0671`; its current runtime started at `2026-11-07T14:37:58.332Z` and has no `logs.runner` locator. Listing its retained managed dev/run logs returned eight files, all older than this incident. The original worker's stdout/stderr socket descriptors also do not identify a retained log file.
- Installed compiler contract: esbuild 0.27.2, `node_modules/esbuild/lib/main.js:1975`. Its service already sends stdin/child errors and stdout EOF to `afterClose`, which rejects pending requests.

## Canonical owner and affected corridor

- `apps/stack/scripts/build/build_source_runtime.mjs:824`: shared daemon/server build preparation; `:883`: finite worker invocation; `:1017`: dependency-consumption scope; `:1040`: capture/emission; `:1080`: cleanup and `esbuild.stop()`.
- `apps/stack/scripts/utils/proc/runSourceBuildCommand.mjs:25` delegates execution to `workspace_build_admission.mjs:116`; the latter settles on the foreground child's `close` event. It does not impose a separate elapsed-time cutoff.
- `packages/cli-common/sourceRuntimeEntries.mjs:228` owns workspace import resolution, including awaited `builder.resolve`; main emission also awaits captured-file reads, plugin/resource phases, author compilation, and sidecar builds. An idle native service does not tell which of these is pending.
- Shared/standalone daemon and server builds use the same owner. Their upstream reload consumer is `apps/stack/scripts/runtime/launch/prepareSourceRuntimeReload.mjs`; finite command execution is shared with web preparation. No alternate source-runtime compiler owner was added or changed.
- Existing owner coverage includes `apps/stack/scripts/build/build_source_runtime.test.mjs:4471`, which checks that real one-shot preparation processes retire after success and ordinary build failure. Service-loss discrimination is tested separately below.

## Validation

- A constructed real-service probe is queued through `hstack-exec --local -- node --test /tmp/repo-dev-gen-stall-1107-vsebedn8/esbuild-lifecycle.test.cjs`; this must execute on the machine containing the OS-temp fixture. Its diagnostic log confirms `class=validation` host-admission waiting; TAP has not started. This is distinct from the reported already-admitted build stall.
- The probe starts the real esbuild service, waits until a real build enters `onLoad`, kills only that recorded service PID while the callback remains pending, expects build rejection, then stops the old service and builds successfully with a fresh one. Only the child-process boundary is observed; esbuild's internals are real.
- Terminal result: PENDING / NOT RUN while host admission is queued. Existing execution handle: `83150`; log: `/tmp/repo-dev-gen-stall-1107-vsebedn8/lifecycle.log`; observed queue-process PID: `3358777`. Resume that handle rather than dispatching another copy. No passing check is claimed before it completes, and the queued check was neither killed nor given a queue timeout.
- Production RED → GREEN, package build/typecheck, and loaded repo-dev replay have not run: there is no reproduced missing behavior or source patch. No TypeScript or production source changed.

## Required next observation and disposition

1. Systemic should supply the original source-build stderr/phase log, or capture the pending JS/native stack at the next stall before retiring that exact worker. Diagnostics must exclude argv, environments, credential values, and source contents.
2. Correlate the last completed phase with the wait: dependency-publication/resource wait, captured-file operation, pending resolver callback, native service request, compiler child, or cleanup. Inspect the named producer's actual terminal event before selecting a correction.
3. If the real service exits/loses IPC and its owning operation remains pending, reproduce that precise path at the canonical owner before adding lifecycle settlement. An alive but idle service emits no failure event from which an elapsed-time limit can be derived.

- Brief goal 1: **[blocked]** exact pending operation unavailable from retained evidence; next action is the Systemic capture above.
- Brief goal 2: **[blocked]** no production RED or cause-specific fix; adding a guessed timeout or duplicate service-EOF handling would not resolve the demonstrated evidence gap.
- Brief goal 3: report-only private-index commit; its SHA is handed to Systemic and returned in the delegation result. No repo-dev restart is requested until there is a justified patch to load.
- Board ASK: `HANDOFF-OTHER-PROGRAMS.md`, sender `repo-dev-gen-stall-1107`, subject `Need the stalled build phase or pending-stack capture`.

## Self-review and residual risk

The service-exit probe attacks the proposed missing-EOF-handler explanation rather than assuming it. Current source differs from the historical running worker, so current behavior cannot certify the old incident's cause. No competing owner or mitigation was introduced. Mechanism delta: checks/states/error codes/timers/retries **+0 / −0**; production files **+0 / −0**; requested report **+1 / −0**.

Residual risk: the serial watcher may stall again because the originating pending operation has not been identified or fixed. A passing constructed service-exit probe would establish only the tested lifecycle behavior, not recovery from a live-service deadlock, dependency wait, or filesystem stall. macOS/Windows and the loaded repo-dev runtime were not exercised.
