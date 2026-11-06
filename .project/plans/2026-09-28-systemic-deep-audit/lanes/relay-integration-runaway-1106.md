BLOCKED

Outcome: the 30-minute current-source attempt did not establish a reproduction; worker admission and synchronization prevented a deciding observation. No production fix is justified.

- Evidence root: `.project/tmp/relay-integration-runaway-1106/`.
- Exact replay: from `apps/cli`, `../../apps/stack/bin/hstack-exec -- pnpm exec vitest run --config vitest.integration.config.ts src/cli/commands/relay.access.json.runtimeCatalog.integration.test.ts`.
- Observed window: 2026-11-06 08:40:39Z–09:10:53Z, 1,814 seconds; cancelled through recorded controller PID 1996821, terminal exit 130 (`reproduction.{started,finished,pid,exit}`, `reproduction.log`).
- Selected execution: nl3, `native-WluZF1-7-1793954446`; emitted `waiting for admission (class=package-dist, waiting=5/6)`.
- Last successfully observed phase: admission. Remote trees at 08:43:49Z and 08:52:31Z showed root PID 1714790 and descendants; the only nonzero CPU time was one second on PID 1721009, unchanged between samples (`remote-observation.log`, `remote-observation-2.log`). No workspace package build locks were observed in those samples.
- Preparation/declaration/test phase durations: unavailable; no preparation progress or test results appeared in the replay log. This does not establish their state after the last successful process sample.
- Final process observation failed because nl3 synchronization was not ready (`remote-observation-final.log`). Remote termination could not be independently verified; the local controller settled with exit 130.
- Cause: unresolved. Current observations show an admission wait, not the reported full-core compiler spin. They cannot distinguish pathological declaration traversal, watch, or retry behavior in the historical run.
- Historical evidence: `../idle-lease-holder-nl1-1106/remote-followup.log` associates PID 418814 with protocol `activityV1.d.ts`; `declaration-stat.log` records 573,429-byte live/captured declarations. References and size do not prove the cause.
- Source basis: replay started at HEAD `11066da845f74ea0441c80890d3ffded678c0c5d`; the shared checkout continued moving. Exact uncommitted 11-05 source bytes were not recorded by this lane.
- Verified source difference: ancestor commit `5e87c72e84730e61f0066fbfcc621712516eca1a`, 2026-11-06 02:03:16Z, adds named Availability response declaration types in `packages/protocol/src/plugins/availability/v1.ts`. This postdates the reported 11-05 start; whether it resolves the historical runaway is unproven.
- Canonical corridor inspected: integration config → `src/test-setup.integration.ts` → CLI full setup; executor runtime preparation → `remote_validation_workspace.mjs` → workspace build owner. No consumer workaround or competing owner was added.
- Checks: replay cancelled before any observed test result; RED/GREEN and package compilation are not applicable because production source was unchanged.
- Required entry-load attempt: `pnpm check:entry-loads`, exit 1; `HSTACK_EXEC_DISPATCH_REFUSED` before payload start (target prerequisites/synchronization), so entry-load validation did not run (`entry-loads.log`, `entry-loads.exit`).
- Fix/mechanism delta: none; checks/states/error codes/timers/retries +0/−0, production files +0/−0. One requested lane report added; no stack restart, database access, or board post.
- Next action: rerun the exact replay when a synchronized worker can admit package-dist preparation; collect its process tree and canonical build progress through preparation and the test before choosing an owner fix.
- Residual risk: the original runaway remains unresolved; late replay phase and remote cleanup were not independently observable after synchronization failed.
