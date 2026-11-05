Status: BLOCKED — refusal mechanism identified; transport-exit cause and low-memory latency remain unproven.
Orchestrator summary: Both reported refusal windows coincide with Mutagen beta broken pipes, not a dispatch deadline.
Twelve live flushes passed in 2.366–5.123 s; watching cannot accelerate an explicit Mutagen 0.18.1 flush.
No runtime/config/session changes justified; transport incident owner needs the terminating SSH/agent evidence.
Validation: control 18/18 and entry-loads 7/7 passed; AUTO first excluded mac3-linux for pre-payload admission-state failure, then completed on windows2-linux.

## Observed failure and owners

- `apps/stack/bin/hstack-exec:1228` prepares inputs and delegates to `hstack-dev-target-control --sync-flush`; `:2244` waits without a deadline.
- A nonzero flush result becomes `dispatch-sync` / `nl3=sync` at `hstack-exec:2259`; pinned execution refuses before starting the payload.
- `apps/stack/bin/hstack-dev-target-control:334` owns per-session serialization/coalescing; `:269` waits for Mutagen and validates fresh health. Neither wait has a timeout value to raise.
- Native/JSON readiness share `mutagen_runtime.mjs` and its generated `native_sync_readiness.sh`; `executor.mjs:145` uses the same native control on POSIX. Windows performs its existing post-flush inspection. No competing new owner was added.
- Five retained `.project/tmp/QA-DOMAIN-1104/{domains-account-rest-r63,fresh-network-first-review-predispatch-r65,fresh-software-apply-r65,fresh-version-files-r65,fresh-app-preview-r65}.stderr` files contain real Mutagen inability/failure responses, not timeout expiry.
- Controller monitor `/home/leeroy.guest/.happier/stacks/repo-dev-a1cc5e0671/logs/mutagen.log:50489` records beta staging broken pipe at 00:54:43.173Z; `:51485` repeats it at 01:21:23.973Z. Both immediately reconnect, resetting cycle counts.
- The same monitor `:50690` records a beta scan unexpected EOF at 00:59:32.242Z. Derived: loss of the beta transport explains these refusal windows; the process/network reason for that loss is not recorded here.
- Preserved, redacted incident transitions: `.project/tmp/nl3-slow-flush-1105/incident-monitor.txt`. No session was paused, terminated, reset, recreated or reconfigured.

## Watching and latency

- `mutagen_project.mjs:215` selects source watching by actual service placement; `:228` emits portable/no-watch, and beta remains no-watch. Scoped-standby `:143` is a different branch.
- Recorded rationale: commit `0158264da4c` and `lanes/mutagen-scan-cost-1102.md` removed idle command/build scans while retaining dispatch freshness; its measured daemon CPU/scan reductions are historical evidence, not remeasured claims here.
- Installed version: `mutagen version` = 0.18.1. Its [controller implementation](https://github.com/mutagen-io/mutagen/blob/v0.18.1/pkg/synchronization/controller.go#L947-L965) forces full warm scans on BOTH endpoints for every explicit flush, regardless of watching.
- The same [flush implementation](https://github.com/mutagen-io/mutagen/blob/v0.18.1/pkg/synchronization/controller.go#L328-L385) distinguishes cancellation from loss of synchronization. Derived: enabling watches would retain full dispatch scans and reintroduce idle work; it is not the proposed incremental-scan fix.
- Existing monitor spans: 01:22:27.690–01:22:40.183Z Scanning = 12.493 s; 01:23:10.840–01:23:13.192Z = 2.352 s. These spans do not attribute the entire reported 62 s probe to scanning.
- Read-only controller sampling plus 12 allowed flushes, 01:27:40.951–01:31:04.796Z: minimum/median/maximum 2.366/2.9205/5.123 s, all exit 0; controller MemAvailable 51.59–96.67 GiB and load1 24.38–30.61; memory PSI some avg10 remained 0.
- Evidence: `.project/tmp/nl3-slow-flush-1105/{sample.py,samples.jsonl,measurement-summary.json}`; samples include before/after memory, cache, reclaim, major faults and memory/I/O pressure. Other shared commands ran concurrently.
- Cache hypothesis: unverified for the historical low-memory interval. No sample reached the reported ~12 GiB, and no pressure was manufactured. Healthy current samples cannot establish or exclude that historical cause.

## Decision, validation and next action

- Keep the canonical causal flush barrier and real-failure refusal. Do not add retries, timers or guessed timeout increases. Changing the barrier/topology requires an owner decision and measured evidence; no such change is justified by these observations.
- [blocked] Root correction needs the nl3 SSH/Mutagen agent exit cause at the broken-pipe instant, plus contemporaneous controller metrics if the 62 s latency recurs. Existing reconnect already recovers; a person can retry the refused command. Systemic/ORCH-TOP should route that transport diagnosis rather than a watcher conversion.
- Focused existing owner tests: `hstack-exec -- node --test apps/stack/scripts/dev_target_control.test.mjs` PASS 18/18 on nl3, exit 0; `.project/tmp/nl3-slow-flush-1105/focused.log`. Tests cover failed/canceled flush rejection, coalescing and fresh health. No production change, so RED/GREEN is not applicable.
- Loaded dispatch: `hstack-exec --target=nl3 -- /usr/bin/printf 'nl3-live-dispatch-ok\n'` PASS, exit 0 at 01:30:40Z; `.project/tmp/nl3-slow-flush-1105/live-dispatch.log`. This exercises the previously failing pre-payload phase, not the original QA mutations.
- Entry-loads: PASS 7/7 current-source graphs on AUTO-selected windows2-linux, exit 0; `.project/tmp/nl3-slow-flush-1105/entry-loads.log`.
- Read-only nl3 kernel journal query, 00:50–01:25Z: exit 0, zero visible retained records, no access warning. This cannot establish absence of OOM/process termination; `.project/tmp/nl3-slow-flush-1105/kernel-observation.log`.
- Commit scope: this report only, through the required private-index type-coherence finalizer. No source changes, no pushes, no foreign hunks included; commit identity is discoverable with `git log -1 -- <report-path>`.
- Self-attack: retained failures refute the timeout explanation; the upstream forced-scan contract refutes the watcher remedy; the pressure sample does not prove historical cache behavior. No root-cause fix is claimed.
- Net mechanism delta: checks/states/error codes/timers/retries/runtime files +0/−0; report files +1/−0, required by the brief. Existing sessions and other hosts' synchronization configuration left running unchanged.
- Residual risk: transport loss can recur; low-memory latency and the full 62 s attribution remain unresolved. No Windows/macOS runtime validation or package-wide typecheck was needed for this report-only result.
