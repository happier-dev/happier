Verdict: IMPLEMENTED; [blocked] package typecheck evidence.
The canonical CLI typecheck stopped in declaration preparation (UNKNOWN), before
complete diagnostics; no passing delta is claimed. All launched checks are terminal.
Broader checks also have unresolved failures, listed below.
Security exception: an early search printed a synthetic fixture credential line;
subsequent fixture/log reads were redacted before stdout. No real secret exposure observed.

Outcome
- The dependency admission owner publishes its own decision through an observer;
  the daemon immediately writes sourceRuntimeReloadRequired through its existing
  lifecycle-lock-owned daemon status publisher. Repeated equal decisions do not write.
- The existing schema retains the field. Heartbeats preserve it with fileState.
  Successful admission clears it; shutdown removes the observer.
- stack info JSON exposes components.daemon.status=reload-required and the typed
  refusal; the source identity projection clears loaded and carries reloadRequired.
  Human info displays reload-required and the subtype.
- Remote observation preserves the same field; daemon participants and the existing
  READY verdict reject it. Dev-target readiness reads the published record, wakes
  on its atomic replacement, and carries reload-required through its existing stream.

Canonical owners and consumer sweep
- Decision: packages/cli-common/sourceRuntimeDependencies.mjs (no second detector).
- Publication: apps/cli/src/daemon/startDaemon.ts and persistence.ts.
- Observation: apps/stack/scripts/daemon.mjs; stack/stack_info_snapshot.mjs.
- Shared identity projection: runtime/shared/loaded_runtime_identity.mjs.
- Consumers: stack_commands.mjs, stack/daemon_participants.mjs,
  stack/remote_source_runtime.mjs, utils/dev_targets/{daemon_readiness,
  runtime_observer,runtime_snapshot_observation,supervisor}.mjs.
- Same-shape sweep: retained identities masking an admission refusal — local info,
  remote info, participant/READY checks and dev-target readiness now consume the fact.
- Raw remote snapshot probes remain adoption checks; subsequent readiness consumes
  daemon publication. They do not independently detect dependency changes.
- Server identity stays unchanged: this lane addresses the daemon's spawn refusal.
- Optional additive local field: older records remain readable without it; older
  daemons cannot retrospectively publish this new fact. No migration or wire epoch.
- docs/binary-runtime.md documents unreleased 0.3 behavior.

Evidence (all logs: .project/tmp/STACK-INFO-CLOSURE-1110/)
- RED red-stack.log: real daemon-state/ping snapshot returned running instead of
  reload-required after the persisted closure_changed decision.
- GREEN final-stack.log: 3/3 (local JSON, remote JSON, human CLI, READY projection).
- closure-status.log: 1/1, real changed runtime closure emits closure_changed.
- green-owner.log: 1/1, admission observation/entrypoint isolation/success clears.
- persistence.log: 15/15, including real schema/write/read retention.
- supervisor.log: 2/2, worker readiness facts without readiness SSH polling.
- entry-loads.log: 13/13 graphs passed, terminal exit 0.
- adjacent.log: 8 passed, 2 failed, 1 cancelled. Same-size dependency identity
  assertion and remote incumbent-running assertion failed; reattachment timed out.
- adjacent-rerun.log / remote-final.log: remote assertion reproduced; reattachment
  again timed out. Causes unattributed; the new generated-attachment refusal test passed.
- typecheck.log: terminal exit 2; declaration-preparation:UNKNOWN; complete
  diagnostics unavailable. Initial attempts required an explicit valid baseline;
  final invocation used systemic-orch/cli-typecheck-0910.locs.
- verdict-final.log: final strengthened READY assertion passed, 1/1, terminal exit 0.

Self-review / mechanism delta
- Found and fixed remote_source_runtime dropping the published refusal and the
  runtime snapshot presenter overriding reload-required with PID-running status.
- +1 optional persisted fact / -0; +1 presented readiness state / -0; observer
  subscription and filesystem notification carry the owner's reachable refusal.
- +0 detectors/checks, +0 error codes, +0 timers, +0 retries; existing codes reused.
- +1 test file / -0 files; existing owner/consumer/test modules and one doc updated.

Residual risk / next action
- [blocked] Rerun the canonical CLI typecheck after declaration preparation works.
- Resolve the three unsuccessful adjacent checks before claiming corridor-wide green.
- No Stack was started, stopped, or reloaded; no database mutation or ../0.2 access.
  Existing running daemons need an owner-managed reload to publish the new field.
- Windows/macOS live behavior was not exercised; notification code uses Node APIs.
