IMPLEMENTED_NOT_VERIFIED — focused checks and entry-loads passed; Fork C's live replay and integration-owned UI typecheck remain owed.

Observed defect: QB129 Rerun106 Gate0; admitted Asleep target advertised wake, but folder preflight/status still required a running daemon.
Owner reused: `buildMachineDestinationModel.ts#resolveMachineDestinationPurposeEligibility`; no new wake authority or wake transport.
`useNewSessionMachinePathState` consumes admitted managedWake, defers separated-directory preflight and preserves the exact chosen folder.
On Online, ordinary preflight resumes; regression tests prove an invalid chosen folder is still refused.
`useNewSessionAgentInputPresentation` consumes the same destination result and existing wake-description presenter.
`useNewSessionScreenModel` consumes that status and fact, removing its separate presence veto and suppressing asleep-only folder-read failure.
Send admission already consumes destination eligibility through `canCreateNewSession`; no second wake path was needed.
Existing Session cold Send now: real HTTP/Socket-boundary test passes with offline Machine, nativeReady=false and asleep managed runtime; accepted input retains custody through existing wake owner.

Constructed RED: asleep/starting directory cases both refused ready=true; presentation case lacked wake description (red.log, presentation-red.log).
GREEN: focused owner/adjacent selection 9/9; cold Send now 1/1; full canCreateNewSession 13/13 in path-green.log.
Entry-loads: exit0; all 13 graph checks passed (includes daemon, CLI, server, UI catalog and SDK browser).
Broader check failed: path-green.log has 86 passed / 5 failed, in archive policy and selection/reconnection cases outside changed decisions; attribution remains with integration owner.
Initial presentation run also hit the existing withdrawal expectation; current reachability owner deliberately keeps presence on withdrawal. That expectation was not changed.
Presentation's first GREEN attempt failed because its heartbeat fixture retained a recent timestamp; corrected the new asleep fixture to activeAt=0, then focused GREEN passed.
Evidence: `qa-shots5/gaps/wake-send-1109/{red,presentation-red,path-green,presentation-green,focused-green,cold,entry-loads}.log`.

Same-shape sweep: daemon-online-only veto despite admitted managedWake — 4 sites fixed: directory preflight, connection status, folder availability, folder-read failure; existing Session cold Send now routed through existing submit/wake owner and tested.
Repo-wide symbol sweep also reached CLI/server directory-preparation and Action preflight; these are effect-time filesystem/authorization boundaries, not composer availability decisions, and remain intact.
Consumers: New Session screen/wizard/host presentation share these owners; host-bound selection remains exempt as before; existing Session submit unchanged. Shared TypeScript applies to web/native/desktop.
Touched: three existing production files above; their path-state/presentation tests; `sync/ops/sessions.managedPendingWake.test.ts`; this report and evidence.
Commit packet preserves compatible concurrent Action-default/Profile authoring and exact-target/no-folder hunks in shared files; no foreign hunks reverted.
Self-attack: ordinary offline/key/access refusals remain owned by destination/spawn readiness; Online invalid-directory control fails closed; no new runtime wake call or polling.
Net mechanism delta: independent presence checks +0/−1; existing checks refined in place; projection field +1/−0 carries admitted wake to folder presentation; wake-description branch +1/−0 prevents the observed false offline message.
States/error codes/timers/retries/Actions/new production files +0/−0; requested report +1/−0. No contract documentation change: existing approved wake behavior is projected consistently.
Residual risk: no browser or lifecycle action performed; Fork C must replay Rerun106 Gate0 plus cold same-conversation Send now on the loaded fix; UI typecheck belongs to its integration wave.
