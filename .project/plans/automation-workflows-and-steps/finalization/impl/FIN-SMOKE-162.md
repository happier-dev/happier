VERDICT: Startup failures diagnosed; reload-162 replay PASS. Initiating stall / source fix / revision [blocked].
No production fix is justified by the recovered runtime; this lane commits the diagnosis only.

- Stack agent-qa-fin2, nl3; supplied identities server 4ed39c0bb09aeb92 / daemon f71bfb26378dd3c7;
  same loaded server PID 3901028 and daemon PID 3901617. No lifecycle action was performed.
- Evidence: .project/tmp/FIN-SMOKE-162/loaded-failures.log preserves safe errors/stacks.
- e8ba6137-c57d-49cb-a517-91498c91de02 is the Machine. The smoke creates/deletes fresh Workflows/Runs.

Failure 1: Run 5b3f89cc-b1ed-4684-a5f5-9b2152222509
- Session cmw7dsyze000cmc1wt21jj8en; child log cli/logs/2026-11-08-06-18-16-pid-3914881.log.
- Observed :112: agent_runtime_open → project_workspace_unavailable, phase client_start,
  preparationCause {code:project_workspace_unavailable,stage:dispatch}.
- :124–126: runner exit 1; PluginError → createSanitizedNativeStartupError (remaining path redacted).
- Server logs/server.log:3508–3513, 05:18:49.106Z: P2028 expired-timeout;
  GET /v1/account/encryption → 503/database_transaction_timeout.
- Derived: Project association admission failed on its required Account read before native opening.
  Canonical owner: apps/cli/src/workspaces/projectSetup/projectSetupAcceptedWorkspace.ts:36–47;
  its catch maps a failed row read to project_workspace_unavailable. The precise caught object was not logged.

Failure 2: Run d9dc14f2-194e-4152-b7b8-d89942e33b0c
- Session cmw7dwbri000ymc1wt66k3d2s; child log cli/logs/2026-11-08-06-20-53-pid-3929103.log.
- Daemon :4254–4296: OS spawn succeeds and runner_webhook completes in 5628 ms.
- Child :99–101: AccountEncryptionCurrentnessUnavailableError,
  code account_encryption_currentness_unavailable (503), then home.read server_error/503,
  then agent_runtime_open fails with preparation_pending, reason unavailable.
- Stack: fetchAccountEncryptionCurrentnessFromServer → fetchAccountEncryptionCurrentness →
  ConnectedServiceCredentialHttpClient.getAccountEncryptionCurrentness → ApiClient → ApiSessionClient.
- Server :3515–3521, 05:21:26.665Z: TransactionDeadlineExceededError/database_transaction_timeout
  on encryption/currentness, settings/history, Sessions, Machine batch and stored-definition reads.
- Server stack: inTx wrapped callback → db.$transaction → timeWebLatencyPhase → Account route.
  Loaded chunk-WHN5CGOF.js:2:5191424 rejects an already-expired deadline at transaction entry;
  exact offsets and child stack are in loaded-failures.log. The initiating scheduling/queue stall is unknown.
- Owners: apps/server/sources/storage/inTx.ts:292–314 and
  apps/cli/src/agent/prompts/library/homeReadPreparationError.ts:16–30 (CLI classification).
- MCP sign-in warnings precede completed MCP preparation; custody-recovery and lease expiry
  are correlated observations, not established initiating causes. No OS executable failure was observed.

History comparison, working bytes, and live falsifier
- commit-window.log records all 13 commits from the requested git-log window; no executable bisect ran.
- 7189fd0b6e changes history reply settlement, not DB admission; 633990b2dc changes Agent isolation;
  0491b8ace7 / 14197529a9 change inventory readiness. No introducing commit was isolated.
- owner-working-tree.diff: inTx adds only a replay-reason union member; Project launch adds requesterIdentity;
  accepted-workspace admission, Home classification and Workflow startup failure owners have no HEAD delta.
- Uncommitted Project-row selection changes were inspected; no causal foreign change/owner was established.
- Primary prior-runtime-failures.log proves P2028 timeouts on reload 161 at 03:54:05.202–.210Z,
  before 7189fd0b6e; therefore that fix did not introduce this class of failure.
- Replay: same Machine, /home/happier, happier.agent.codex/codex, null Profile, 120-second wait;
  Run e99c5d1d-38aa-4faf-988f-81567d3997d0 succeeded; Session cmw7e2rq7001imc1wt09k9oe6.
- live-smoke.log: PASS; startup 66282 ms, product 87834 ms; archive/delete cleanup succeeded.
- run-record-existence.log: metadata-only SQL finds none of the three Runs after cleanup;
  a read-only CLI probe exited 1 without an envelope, supplying no failure-detail evidence.

Validation and handoff
- focused.log: real Workflow Session executor + Project-key suites, 175/175 PASS, exit 0.
- entry-loads.log: check:entry-loads 7/7 PASS, terminal exit 0; retained the original AUTO handle.
  Admission first refused memory on windows1-linux, then completed on linux1; no manual reroute.
- No production behavior changed; no constructed RED/GREEN or package typecheck is claimed.
- Commit scope: this report only, private index → commit-tree → CAS; SHA accompanies final delivery.
- Net production mechanisms/checks/states/errors/timers/retries/files: +0/−0; one requested report added.
- Residual: [blocked] initiating DB/server stall and causal revision remain unproven; a later read-only
  pg_stat_activity sample found no blockers, which does not explain the earlier incident.
- FIN: no fin2 reload is needed for this report-only result. If failures recur, capture server scheduling
  and DB acquisition/waits during the failure before assigning a source owner or changing budgets.
