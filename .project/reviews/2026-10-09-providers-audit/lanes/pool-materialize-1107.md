STATUS: DONE — transient 0.2-runner incident; 0.3 shape verified

- Scope: owner/Coordination reports pool launch run_392d6504 succeeded at 12:08Z without data changes. Compatibility investigation stopped per owner; no 0.2 correction or restart is in scope.
- Observed runner module: `0.2/apps/cli/.runner-snapshots/5637ea5e4b709f20/index.mjs` (process module-path inspection, no environment/credential reads).
- The reported `execution_run_connected_services_unavailable` error is declared in 0.2 `agent/executionRuns/runtime/prepareExecutionRunConnectedServices.ts:48`; it is absent from current 0.3 source searched under CLI/packages.
- Current 0.3 owner: `daemon/connectedServices/resolveConnectedServiceAuthForSpawn.ts` resolves qualified groups and feeds the canonical materializer. Sessions and execution-run materialization consume it.
- Health authority: Protocol `connect/connectedServiceSchemas.ts#isConnectedServiceCredentialHealthStatusUsable` explicitly permits `refresh_failed_retryable`; candidate selection consumes this predicate.
- Test change: `resolveConnectedServiceAuthForSpawn.qualifiedCredential.test.ts`, existing group-freshness case expanded to six enabled members: ready active leeroy_bat, lb_batiplus, leeroy, batiplus, ai3_bat, and retryable codex3. All members have fresh quota evidence to isolate health from quota unavailability.
- Assertions: preparation succeeds, retains group happier and active leeroy_bat, reads only the selected credential at its two required boundaries; stale quota still refuses, and existing ready-backup recovery still materializes.
- Boundaries: real preparation, group/profile schemas, usage store, purpose admission, envelope handling and plugin materialization; only HTTP/storage is replaced.
- Validation PASS: `hstack-exec -- pnpm --filter @happier-dev/cli exec vitest run --config vitest.config.ts src/daemon/connectedServices/resolveConnectedServiceAuthForSpawn.qualifiedCredential.test.ts -t 'group quota freshness'`: 2 passed, 26 intentionally unselected; exit 0 at 12:57Z. Raw log `/tmp/pool-materialize-red.log`.
- Entry-loads PASS: `hstack-exec -- pnpm check:entry-loads`, 7/7 current-source graphs; exit 0 at 13:23Z. Raw log `/tmp/pool-materialize-entry-loads.log`. Both queued jobs completed normally.
- No production edits, package typecheck, shared-daemon restart, environment/credential inspection, or push.
- Commit scope also preserves the existing Providers freshness, requester-profile and purpose-inventory fixture changes in this shared test file; no foreign hunks were removed.
- Test-only change: no production checks, states, errors, timers or retries added/removed. No canonical documentation change is needed because behavior already holds.
- Self-check: an implementation rejecting a group because any member has retryable health would fail the six-member case; the two-member case and stale-quota refusal distinguish normal materialization from unconditional admission.
- Residual risk: the transient 0.2 cause was not established; owner closed that investigation. No live 0.3 run is claimed; no daemon restart is needed for this test-only change.
