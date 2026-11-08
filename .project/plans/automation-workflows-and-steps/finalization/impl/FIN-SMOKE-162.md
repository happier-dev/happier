VERDICT: Typed startup-cause loss fixed; 229 tests and entry-loads 7/7 GREEN. CLI typecheck queued.
Observed launch cause: project_workspace_unavailable at native Agent open; initiating Home/DB stall unresolved.

- Runtime: agent-qa-fin2 / nl3, reload 162; server 4ed39c0bb09aeb92, daemon f71bfb26378dd3c7.
- Evidence: .project/tmp/FIN-SMOKE-162/; FIN-QA inputs: .project/tmp/fin-qa-161a/. No lifecycle action or data/index mutation.

Observed new failures (daemon/child log times are CET; server evidence below uses UTC)
- Run ecbaac28-79c9-411f-9e85-bb483fd56614; operation 63e205cb-f409-4a7e-b06f-f5fdf50798e2;
  seed 2ac0b323-9688-459e-af64-c834cf8f63e9, Session cmw7gc499005jmc1wmztez1zi.
- recurrent-operation.json: terminal operation revision 3 has only SPAWN_FAILED, no typed result.
- Daemon :12943–13023: preparation, OS spawn PID 4185407, webhook all succeed (4648 ms).
- Child cli/logs/2026-11-08-07-29-08-pid-4185415.log:112: agent_runtime_open fails;
  failureCause {code:project_workspace_unavailable,phase:client_start,preparationCause.stage:dispatch,retryable:false}.
- Child :131–136: PluginError → createSanitizedNativeStartupError → logCodexNativeStartupFailure →
  openCodexNativeAppServerSession → openCodexSession → Object.open; paths were redacted by the producer.
- Server logs/server.log:3658–3659: /v1/account/encryption returns 503/database_transaction_timeout
  at 06:29:40.963Z, 45 ms before the child's failure. Further DB failures occur at 06:30:20Z.
- Retry operation e7ffb30f-f06b-4851-add1-ff4ff2694864; Session cmw7gjvwe006amc1wd89wx2he.
- Child cli/logs/2026-11-08-07-35-11-pid-4820.log:112: same cause at 06:35:43.099Z.
- Server :3742–3744: /v1/account/encryption returns 503/database_transaction_timeout, Prisma P2028,
  at 06:35:43.051–.052Z, 47–48 ms earlier. More DB failures at 06:36:16Z; retry-trace.log preserves them.
- recurrent-failure.log preserves the first trace, metadata-only server errors and safe stack frames.
- Server stack: TransactionDeadlineExceededError → inTx wrapper → db.$transaction → Account route;
  loaded chunk-WHN5CGOF.js:2:5191424 / :5194534, later :5198402 / :5198654.

Derived cause and limits
- /home/happier is the accepted directory/checkoutRootPath on Machine e8ba6137-c57d-49cb-a517-91498c91de02.
- Project association reads Account mode before workspace rows: projectAccountRows.ts:248 → /v1/account/encryption.
- projectSetup/projectSetupAcceptedWorkspace.ts:36–47 maps failed reads to project_workspace_unavailable.
- Thus the code reports unavailable Project association data, not proof that the directory is absent.
- Both new launches correlate with the required read failing; the caught exception itself was not logged.
- No signed-Project mismatch, missing executable or physical custody failure established; kernel journal supplied no accessible OOM evidence.
- [blocked] Initiating scheduling/DB acquisition stall: collect server/DB wait evidence during the next failing native open.

Owner fix and coverage
- Canonical exit owner: apps/cli/src/daemon/sessions/onChildExited.ts retains validated stderr cause
  in spawnStartupReadinessFailure after actual exit, including after webhook custody has ended.
- runnerAgentSessionOpenAttestation.ts consumes that exact tracked runner's cause before optional Home reads.
- Existing Session startup/result projection → Workflow composition error → executor/coordinator → Run reason/UI
  carry the original code. Existing UI failureCause.code/details display consumes the retained Run reason.
- Persisted fallback/source/birth checks remain; pre-webhook capture shares its producer. No competing classifier. Runtime-core docs updated.
- RED: typed-cause-red.log shows expected project_workspace_unavailable becoming SPAWN_FAILED.
- GREEN: typed-cause-green-final.log, 221/221 across Workflow executor, attestation and startup custody.
- Clear metadata intentionally omits preparationCause; the test checks public code/retry facts and the full operation result separately.
- Adjacent Project association / wrapped-runner suites: 8/8 PASS, workspace-adjacent.log.
- Entry-loads 7/7 PASS, exit 0, typed-cause-entry-loads.log; public CLI typecheck queued, typed-cause-typecheck.log.

History, commit and FIN action
- commit-window.log covers all 13 requested-window commits; no executable/reload bisect was performed.
- d7d7ac4c69 (02:47Z) and c164259686 (02:02Z) predate reload 161's passing smoke; neither is isolated as causal.
- prior-runtime-failures.log proves DB timeouts on reload 161; live-smoke.log records an earlier same-162 PASS.
- New same-162 replay PASS: Run 4dbe5fa8-99f6-4087-a3eb-57956540c4aa, Session cmw7h8d7a006wmc1wk0fnd67l;
  recurrent-live-smoke.log: startup 68636 ms, product 89513 ms, cleanup successful. Failure is intermittent.
- live-db-waits.log: four snapshots during replay bootstrap show no lock blockers; some ClientRead waits reach 14 s.
- Original two failed Runs and their typed child/server traces remain in loaded-failures.log; cleanup deleted those Runs.
- No causal foreign working-tree hunk or introducing revision isolated; no foreign work reverted.
- Lane mechanism delta: checks +2/−0 to retain/consume proven exit cause; states/errors/timers/retries/files +0/−0.
- HEAD-relative review isolates five lane-owned paths; unrelated shared staging and stale entries are untouched.
- Commit uses private-index → commit-tree → CAS, exactly the five reviewed paths; no push. SHA accompanies final delivery.
- FIN: reload fin2 is needed to load this diagnostic fix, then rerun smoke. Existing failed Runs are not backfilled.
- Residual: the diagnostic fix explains future failures; it does not repair or conceal the underlying Home/DB outage.
