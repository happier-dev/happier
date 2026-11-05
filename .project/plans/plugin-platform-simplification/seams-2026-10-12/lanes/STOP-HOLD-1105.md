STATUS: DIAGNOSED — owner handoff; live completion blocked on QA server reload

Action: Coordination/Systemic, please reload only the `agent-qa-surfaces-shared`
server using the current Usage schema/producer. QA-R90-BROWSER then replay
present-user Stop, verify the persisted hold survives refresh and prevents automatic
wake, and verify explicit Resume clears it. No stack was restarted by this lane.

Cause: the loaded server rejects the top-level `usageTimingV1` field in
`PATCH /v2/sessions/cmw43buql0083mcth4xo8dfwp` before version/envelope admission.
Observed original Stop: HTTP 400 `Invalid parameters` at 2026-11-05 22:22:17Z;
physical stop succeeded in 308 ms; metadata version remained 17 without a hold.
The original request body was not retained; attribution of that original failure
to this field is derived from the writer, compiled validator and differential below.

Writer: `packages/cli-common/src/sessionMetadata/updateSessionMetadataTupleWithRetry.ts:690`
(`buildPreparedSessionMetadataTuplePatchV1`) adds the Usage timing projection.
UI Stop authors the hold through `apps/ui/sources/sync/ops/sessions.ts:1505`;
CLI Stop uses `apps/cli/src/session/services/sessionExplicitStopIntent.ts:70`.
Both use the protocol hold policy and shared tuple writer, not independent schemas.
Current validator: `packages/protocol/src/sessions/metadata/sessionMetadataSchemasV1.ts:268`
(`SessionMetadataOwnerPatchV1Schema`); line 270 already admits `usageTimingV1`.
HTTP validator: `apps/server/sources/app/api/routes/session/registerSessionPatchRoute.ts:42`;
lines 95–96 turn request validation failure into this exact 400 response.

Actual loaded validator: nl3 server PID 2258693, selected/loaded identity
`7a63703c7b82f5b5`, captured 2026-11-05 01:50:52Z. Beneath its runtime root
`/home/happier/.happier/dev-targets/nl3/stack-state/source-bundles/runtime-60932b36aaf27613abf10990801ef2b6a1f6099d3b66a16f852e4d5a7c12fb5b-qR6gyv`,
`apps/server/src/chunks/chunk-NBZOBYRT.js:2` embeds a strict owner schema WITHOUT
`usageTimingV1`; `apps/server/src/chunks/startServer-FNGQE4TC.js:2` runs that schema
and emits the 400. The loose Protocol dist file beside it is newer and is not
the embedded validator the server executes. Evidence: `.project/tmp/STOP-HOLD-1105/loaded-schema.json`.

Observed HTTP RED/differential (22:59:22Z): authenticated encrypted owner PATCH
against Session #34 with deliberately stale expectedVersion 16/current 17:
with `usageTimingV1` → 400; identical body omitting only that field → 409
`session_metadata_version_conflict`. Before/after metadata and activity unchanged.
Thus stale CAS or encryption shape does not explain this schema rejection.
Evidence: `.project/tmp/STOP-HOLD-1105/http-admission-probe.json` and companion `.mjs`.

Hold contract: `packages/protocol/src/sessions/metadata/sessionExplicitStopV1.ts:68`
(`resolveSessionAutoResumeAdmissionV1`) returns `held_by_person` when the persisted
hold exists; lines 92/99 author/clear it. A physical stop without this hold can
allow a later automatic wake. This is a real reachable user-visible defect;
the Session being inactive and the UI showing Resume do not replace the hold.
Consumers include daemon admission, CLI action transport, SessionClient and follow dispatch.

Fix ownership: the open Usage program already corrected current source; see
`.project/plans/2026-10-09-usage-insights-program/lanes/USAGE-READER-FIX-1104.md`.
Per the lane instruction, route this exact field/validator evidence to that owner;
do not commit its open producer/schema work or introduce another writer, retry
or fallback. This lane changes only this report. Server reload required; no
daemon reload required for this browser metadata rejection. No live fix claimed.

Focused GREEN: real Fastify HTTP + SQLite + shared producer, existing test:
`./apps/stack/bin/hstack-exec -- pnpm --dir apps/server exec vitest run --isolate -c vitest.integration.config.ts sources/app/session/sessionMetadataActivitySummary.sqlite.integration.spec.ts -t 'migrates retained plain metadata'`
passed (1 passed, 15 filtered skips), including owner-migration and owner HTTP writes.
Log: `.project/tmp/STOP-HOLD-1105/focused-http-green.log`. No authored test or production edit.
`check:entry-loads`: `./apps/stack/bin/hstack-exec -- node apps/stack/scripts/perf/entry-load.mjs`
passed 7/7; log `.project/tmp/STOP-HOLD-1105/entry-loads.log`.
All commands used the required HAPPIER_STACK_REPO_DIR; no local escape or timeout.

SHA (diagnosed source HEAD): `c184fe5bf22b16fa013db9d32bddf4caa35d9cc1`.
Report-only commit SHA: `git log -1 --format=%H -- .project/plans/plugin-platform-simplification/seams-2026-10-12/lanes/STOP-HOLD-1105.md`;
also recorded in `.project/tmp/STOP-HOLD-1105/finalizer.log` and the RESULT board post.
One canonical finalizer, private index, own report only; no push.
Net production mechanisms: checks/states/errors/timers/retries/source files +0/−0;
report files +1/−0. No canonical behavior documentation changed because no source behavior changed.

Original QA evidence directory (repo relative):
`.project/plans/2026-08-23-ru2-surfaces-finalization/impl-2026-09-30/lanes/qa-r90b/tmp/r5-final-1105/stop-retry/`
contains `r5-stop-retry-result.json` and `r5-daemon-stop-log.json`.
Residual risk: the loaded QA server still rejects the carrier until reloaded;
the full browser Stop/hold/Resume replay remains blocked on that reload. Current-source
HTTP GREEN is not evidence that the old loaded bundle has been replaced.
