IMPLEMENTED_NOT_VERIFIED — cause transport committed on Coordination's explicit “commit now” direction; live new-participant replay owed after PLUGIN-READMIT-1107 and Coordination's next reload.

| Check | Verdict | Evidence |
| --- | --- | --- |
| Original incident | Observed: Postgres deadline during `invocations.admit`, before Prepare | `.project/tmp/DEBATE-INTERRUPT-1107/original-failure.log`, server lines 45375–45378 |
| Lease 404 | Derived consequence: renewal followed interruption, not its initiating failure | Same log, daemon lines 8227–8229; initial read-only Run observation: interrupted revision 6 at 23:24:32.423Z |
| Retained Run | Observed: only root + rounds frame existed; subsequently cancelled by another operator at 23:37Z | `.project/tmp/DEBATE-INTERRUPT-1107/run-records.log`; original `.project/tmp/REPLAY3-1107-COORD/debate-technical.txt` |
| History | Generic transport flattening predates the suspect evening commits | `.project/tmp/DEBATE-INTERRUPT-1107/route-history.log`; `git log -L`, 45c081072b retained the existing generic response |
| Server RED | Reproduced: expected database_transaction_timeout, received storage_unavailable | `.project/tmp/DEBATE-INTERRUPT-1107/server-red-corrected.log` |
| CLI RED | Reproduced: persisted outer Action reader lost typed failureCause | `.project/tmp/DEBATE-INTERRUPT-1107/cli-red.log`: 1 failed / 5 passed |
| Server GREEN | Deadline regression passes; 13/14 overall | `.project/tmp/DEBATE-INTERRUPT-1107/server-green.log` |
| Foreign RED | Unattributed foreign, in progress; not adjudicated or changed | `registerWorkflowRunStorageRoutes.spec.ts`: “requires exact publisher proof for a verified external Action Account read”; Coordination identified its 23:44:58Z edit |
| CLI cause GREEN | Running/queued at handoff; no terminal success claimed | `.project/tmp/DEBATE-INTERRUPT-1107/cli-green.log`, `cli-debate-green.log`; handles 12656 / 33520 |
| Run cause display | Selected header test running/queued; no terminal success claimed | `.project/tmp/DEBATE-INTERRUPT-1107/ui-cause-selected.log`; handle 19199 |
| Entry loads 7/7 | Pending executor admission; not claimed passed | `.project/tmp/DEBATE-INTERRUPT-1107/entry-loads.log`; handle 42408 |
| CLI / Server typechecks | Pending; no diagnostics baseline or delta claimed | `.project/tmp/DEBATE-INTERRUPT-1107/{cli,server}-typecheck.log`; handles 28808 / 47762 |
| Live replay | Owed by Coordination direction | PLUGIN-READMIT-1107 must restore bundled Codex, then Coordination reloads the stack and replays 1 round / new Codex / gpt-6-luna / low |

The server now consumes the transaction owner's `readDatabaseErrorCode`; it returns the existing safe database code with HTTP 503. The storage client owns the safe operation/HTTP failure projection. The coordinator retains it in the existing root `reason.failureCause` and includes its code in the existing readable reason message. Account invocation readers and the Run presentation consume that retained progress; no schema change is required.

Constructed coverage adds the actual built-in Debate with one new Codex gpt-6-luna/low participant and a deadline before Prepare admission. Existing HTTP 500/503, ambiguous committed writes, cancellation and settlement cases remain. The Run header test covers a needs_attention root before any leaf exists.

Split-brain audit: transaction classification remains in `storage/transactionErrors.ts`; safe diagnostic projection remains `projectActionFailureCauseV1`; the coordinator's former inline storage classifier moves to the storage client. Publication refusals retain their separate existing owner. No second admission, authorization decision or recovery path was added.

Net mechanism delta (lane only): checks +0/−0 admission/authorization decisions; states +0/−0; error codes +0/−0; timers +0/−0; retries +0/−0; files +1/−0 (this requested report). One diagnostic projection now preserves the observed first failure; production files +0/−0.

Compatible foreign hunks carried in the whole-file commit: the unattributed publisher-proof RED above; credential Axios/captured Home transport and removal of the Follow reread in workflowRunStorageClient.ts. Their behavior is not adjudicated by this lane.

No published documentation changes: existing wire/progress schemas and recovery semantics remain; this report records the internal diagnostic correction. No stack lifecycle operation, database mutation, dependency change, or push was performed.

Residual risk: shared-database contention remains Systemic-owned and can still interrupt work. The diagnostic fix does not backfill the original Run. New-participant execution and loaded diagnostic presentation remain unverified until the named plugin repair/reload/replay. Pending checks above must be read from their terminal logs; the foreign RED is not this lane's completed regression.
