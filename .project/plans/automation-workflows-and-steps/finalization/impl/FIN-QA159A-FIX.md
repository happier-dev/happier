> Verdict: F3/F4 and J8 Run fixes committed. Reload165 Session J8 correction passes focused checks and entry-loads 7/7; live replay remains with FIN. Detached Delete **[blocked: product decision]**.
> Commit: `c3776d5917d9f0b5446864edd3f3fb0b5233a2ef`; CAS/read-tree base: `42bcff7178143dd99732ac45d0a9f92a09313efc`.
> Remaining: FIN loaded replay/package integration; broader custody 74/80 and inspector 14/17 had failures detailed below.

## F3 — Discuss exact content read

- Observed runtime basis: `FIN-QA-159A.md` §7.4 and `.project/tmp/fin-qa-159a/r160/`.
- Observed cause: Session Action custody already admitted the requester, but Workflow read only the PAT-specific private material port.
- Owner: `apps/cli/src/daemon/sessionEncryption/requesterAccountActionProjection.ts`; consumer: `session/actions/workflowFamily.ts`.
- Fix: publish already-admitted Session material on the same host-private port; generalize its reader for PAT/Session custody. Machine-setup PAT predicates remain unchanged.
- Authorization seam touched explicitly: host-local requester content custody. No server permission, signed proof, Session scope, or wire format widened.
- Discuss opens the existing execution Session composer; origin IDs do not confer read authority. Signed requester HTTP authorizes reads; receiver material is never substituted; plain mode stays keyless.
- Constructed RED: `.project/tmp/fin-qa159a-fix/f3-red.log` — E2EE Session refused `content_unavailable` (1 failed / 3 passed).
- Constructed GREEN: `f3-exact-green.log` — 8 passed, covering Run and exact invocation reads in plain/E2EE with/without Session custody.
- Negative control gives the foreign receiver matching material; keyless E2EE still refuses. Session positives require distinct requester material; independent review found no blocker.
- Broader `f3-custody-owner.log`: 74 passed / 6 failed (Project launcher, Move-root fixtures, finite SOURCE preparation); unattributed, no unrelated fixes.

## F4 — Interrupted preparation attention

- Observed runtime basis: effect-free Run `02dc8149…`, root `349a1ad5…`, r160 redacted evidence.
- Historic `storage_unavailable` has no `failureCause`: underlying cause **unattributed**. Systemic retains workflow-admit-invocations Postgres deadline investigation; no duplicate investigation.
- Confirmed UI defect: interrupted structural root attention was excluded by the failure selector, suppressing the page's cause/recovery presentation.
- Owner: `components/workflows/run/workflowRunDetailPresentation.ts`; both the screen and direct content consume its selection.
- Further confirmed gaps: the recovery presenter drops typed storage details, and the storage boundary can shadow a safe server cause with Axios `ERR_BAD_RESPONSE`.
- Fix: preserve safe typed cause through HTTP → coordinator → durable root → Action read → existing Technical details; use plain storage headline.
- Existing root Retry uses `workflow.run.invocations.retry`, `fresh_agent`, original input and root causal IDs.
- L2's root-retry case (`.project/tmp/fin-page-l2-1108/qa159a-full-run-green.log:5632`) is ours: `canRetry=false` is **not intended** when exact Action availability permits effect-free root retry.
- Corrected the incomplete boundary fixture; the actual UI control now sends canonical Retry. No new runtime eligibility rule was added.

## J8 — Runtime reload repair (FIN addendum)

- Observed historical159 evidence is `.project/tmp/fin-qa-159b/trigger-v1-failure.txt` and `trigger-v2-failed-1440.png` (the supplied `r160/` prefix is absent).
- `FIN-QA-159B.md` row6 and safe artifact projection confirm raw code outside Technical details and repeated launch; no failed-Run replay on160 is claimed.
- Same recovery owner now presents a plain cause and instructs reloading Happier's runtime from current source on this Machine, then running again.
- Typed/code-only historical `SOURCE_RUNTIME_RELOAD_REQUIRED`, including wrapped launch failure, stays under Technical details; Run again is secondary.
- No callable source-runtime reload Action exists here; repair is manual guidance. An OS restart alone is not promised to repair stale source.

## Detached Delete — explicit stop condition

- Observed: `ExecutionRunActionsMenu.tsx` and published execution-run Action/RPC catalogs expose no retained-history deletion.
- Protocol `executionRuns.ts` has `happySessionId: null`; server `deleteOwnedSession.ts` deletes Sessions and cannot target these daemon records.
- `apps/cli/src/daemon/executionRunRegistry.ts` retains these stopped resumable histories; its GC is not a person-callable delete owner.
- `sessions.external.candidate.delete` owns external discovery candidates, not retained Happier execution records.
- Derived: no person can delete this retained record through an existing owner; UI/Action exposure alone cannot implement deletion. No deletion model added.
- **[blocked] Product decision:** authorize a terminal detached-history delete model and decide whether deletion affects Happier history only or the external provider conversation too.

## Validation, commit, and replay

- Terminal GREEN: F3 `f3-exact-green.log` **8/8**; final `entry-loads-final.log` **7/7**, under `.project/tmp/fin-qa159a-fix/`.
- F4/J8 terminal GREEN under `.project/tmp/fin-qa-159a/`: `f4-final-owner-green.log` **88/88**, `f4-final-screen-green.log` **2/2**, `f4-final-inspector-fix-green.log` **2/2**.
- Storage producer `f4-storage-producer-green-v2.log` **6/6**; canonical root Action `f4-root-action-green.log` **2/2**. Initial invalid-input Debate fixture was excluded, not repaired.
- RED pointers: F3 `f3-red.log`; F4 `f4-owner-red.log`, `f4-typed-cause-red-valid.log`, `f4-runtime-repair-red.log`, `f4-wrapped-refusal-red.log`, `f4-storage-headline-red.log`, initial storage case in `f4-storage-producer-green.log`.
- Broader inspector `f4-final-inspector-green.log`: **14 passed / 3 failed**; two unattributed usage-copy mismatches remain, own obsolete assertion corrected and focused check passed. L2 full suite was not rerun.
- Invalid shared baselines (`cli-typecheck.log`, `ui-typecheck.log`): no delta claimed. Public checks pending: CLI **21503** / `cli-package-typecheck.log`, UI **67577** / `ui-package-typecheck.log`, `.project/tmp/fin-qa159a-fix/`; FIN owns next integration boundary using these handles.
- UI log already records upstream `packages/plugin-sdk/src/protocol/projectExecution.ts:36:TS2322`; no successful package/delta verdict. Preserve supplemental **31117**, `.project/tmp/fin-qa-159a/f4-presentation-green.log` (superseded basis, not a gate).
- Private-index commit verified **13 selected changed paths only**; shared index untouched. Corrected Screen regression already byte-equal to base `42bcff7178`; no push.
- Net: checks/states/error codes/timers/retries **+0/−0**; internal presentation fields **+2/−0** (diagnostics/repair guidance), interrupted-root fallback **+1/−0** (reaches existing recovery).
- Files: **+0/−0** production/test files created/deleted; 14 existing files touched, 13 changed in this commit, plus this assigned report. Shared selector replaces screen-local failure selection; nonfailure human-attention fallback remains distinct.
- No public documentation changes: this restores existing content-read and recovery behavior without changing the public contract.
- FIN replay after reload: FIN-QA-159A §7.4 Discuss → exact read → newer-publication banner; §7.3 effect-free failure → typed cause → fresh-agent Retry; FIN-QA-159B row6/J8 → plain repair guidance → manual Machine reload → rerun, raw code only under Technical details.
- Cleanup Delete remains blocked on the product decision; do not mark it passed after a reload alone.
- Evidence handling lapse: one child artifact read emitted fixture prompt text; no credentials/keys were emitted. Subsequent reads projected only codes/controls; no text is repeated here.
- Residual risk: fin2 remains reload160 (server `231f54c415109e3b`, daemon `1d94e62b4fc71128`); no lifecycle was performed. Historic F4 cause is unavailable; package evidence and loaded replay remain with FIN.

## J8 follow-up — Session open/start, reload165

- Observed `.project/tmp/fin-qa-165/j8.json`, `j8-390-dark.png`: Session-open modal appends the raw code and omits manual repair; accepted-input wake also skips generic alerts.
- One owner: `sessionRuntimeIssuePresentation.ts#presentSessionStartupFailureRecovery`; Run, Session resume/wake, creation and retained startup notices consume its cause/manual Machine runtime reload guidance. Removed Run-local recognition; existing Technical details retains the code.
- RED: `/tmp/fin-j8-session-owner-red.log` **4 failed/35 passed**; `j8-composer-red.log` **1 failed/1 passed**, under fin-qa-165 evidence. Explicit-open case synced the owner fix before admission; wake RED proves the missing recovery-handler branch.
- GREEN: `/tmp/fin-j8-session-owner-green.log` **300/300**, including full WorkflowRunContent **173/173**; `.project/tmp/fin-qa-165/j8-composer-green.log` **2/2**; `j8-embed-adjacent-green.log` **10/10**; `/tmp/fin-j8-session-entry-loads.log` **7/7**.
- Prior expectation correction is already committed `b3c2d8625416fcbc9aade40186e03e1e758529f3`; B1 comment is already committed `6f8645b4ff0fcd339668336650b798d2d306c9b1`.
- Net: one internal manual-repair presentation marker; zero new wire/persisted codes, authority checks, timers, retries or files. Existing alert/disclosure owner reused; compatible unattributed pool-recovery test hunks retained in the shared embed file.
- FIN replay after next fin2 reload: J8 Session explicit Resume and accepted-input wake, 1440/390 light/dark; cause plus manual reload/restart guidance, code only after Technical details. No new live success or package diagnostic-delta claim; FIN retains package integration and historical replay obligations above.
