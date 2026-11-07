DONE — focused owner/recovery tests and entry-loads 7/7 GREEN; wider UI failures and unavailable package typecheck evidence are disclosed below.

Owner: `apps/server/sources/app/session/personal/projection.ts` composes the existing typed activation parser (`pending/pendingActivationAuthorization.ts`) into the Protocol attention resolver's existing `pendingBlockedCount` input.

| Gap | Owner reused | RED / GREEN | Live evidence |
| --- | --- | --- | --- |
| Failed activation missing from Inbox/count | Personal projection + `mapPendingActivationAuthorization` + `resolveSessionPersonalAttentionV1` | Constructed real SQLite admission/failure: RED 2/2 failed for absent pending_blocked; GREEN 2/2, then final 3/3 plus list membership parity 1/1. Exact count = 1 while pending input remains queued/unblocked. | No failed-wake fixture seeded; Inbox rendering belongs to GAP-REQUESTER-INBOX. |
| Clear on recovery | Existing pending-action rearm and withdrawal owners | GREEN: same Session/localId rearms to waiting and clears attention; withdrawal clears authorization and attention. | Delivery's existing `reconcilePendingActivationAuthorizationForRemovedRequestInTx` is retained (materializeNextPendingMessage.ts); no lifecycle change. |
| Shared recovery | `useManagedWakeRecovery` extracted from composer | Banner owner 16/16; composed suite 58/61. A/B reproduces all 3 failures without extraction: zero RPCs expected but 2 observed (:1472); stale-start/stale-start-use receive approved instead of failed (:1531, before Session mounts). Final focused recovery 3/3 GREEN (resume/process_when_online/refused). | Mechanical extraction: no layout, copy or interaction change. |

Semantics observed: `presentationV1.ts` maps pending_blocked to needs_you/blocked_input; `sessionFollowPolicyV1.ts` keeps it in needs_attention across manual read; `accountFollowPersonalProgress.ts` accepts it with existing request reasons. No new reason or wire shape. Notifications/Follow retain their existing policy.

Inbox API: import `useManagedWakeRecovery` from `@/components/sessions/pending/useManagedWakeRecovery`.
Input: `{ accountLifetime, authorization, presentation, actionExecutor, busy, setBusy, requestApproval, onResume, onWithdraw }`.
Output: async callback accepting `'inspect' | 'retry' | 'resume' | 'withdraw'`.
`presentation` is the existing `resolvePendingActivationBanner` result; its `managedWakeProjection` supplies the existing reason and recovery affordances. Supply the same existing Session resume/rearm Action as `onResume`; `onWithdraw` receives the exact PendingMessage. The hook owns eligibility, busy completion, lifetime cancellation, inspect invalidation and approval continuation. Composer uses it unchanged.

Touched paths:
- `apps/server/sources/app/session/personal/projection.ts`
- `apps/server/sources/app/session/personal/pendingActivationAttention.sqlite.integration.spec.ts`
- `apps/ui/sources/components/sessions/pending/useManagedWakeRecovery.ts`
- `apps/ui/sources/components/sessions/composer/useSessionComposerController.tsx` (compatible foreign changes preserved)
- This report.

Commands: AUTO `pnpm --dir apps/server exec vitest run --isolate -c vitest.integration.config.ts sources/app/session/personal/{pendingActivationAttention,listMembershipParity}.sqlite.integration.spec.ts`; AUTO UI Vitest for resolvePendingActivationBanner + SessionView.sendMessage.resumeInactive.pendingQueue; AUTO `--script=check:entry-loads`.
Typechecks: touched commands exited 2 before compilation (explicit `--baseline` required), so no delta claimed. Public UI typecheck exited 1 before UI compilation: unchanged `packages/plugins/deploy-cloudflare/src/definition.ts:43` TS2883, four SDK inferred-type portable-name errors; `/tmp/wake-attention-ui-typecheck.ZAuYVB.log`. Public server typecheck pending. A/B log: nl3 `/tmp/wake-attention-ab.KmAg2w.log`.
Entry-loads first run: 6/7 (foreign Protocol export mismatch); current-source rerun GREEN 7/7, exit 0, windows2-linux, 18:08:34Z; `/tmp/wake-attention-entry-final.kdiV8q.log`. Final UI log: nl3 `/tmp/wake-attention-ui-final.RwkMa8.log`.
Net mechanism delta: checks +1/−0 (typed definite activation failure feeds the existing attention input; reproduced missing Inbox membership); states +0/−0; error codes +0/−0; timers +0/−0; retries +0/−0; files +3/−0 (owner integration test, shared hook, requested report). Existing composer recovery branches moved, not duplicated; no wire/doc contract changed.
Split-brain audit: full viewer and content-free/batch selectors feed the same personal decision; listing/count use its existing candidate/admission owner. Protocol/Follow/presentation remain consumers. Composer's former inline recovery is removed in favor of the hook; managedMachineWake remains the existing admitted runtime executor, not an attention owner.
Residual risk: live failed-wake → Inbox reason/Retry awaits the Inbox lane and a permitted failure fixture; server typecheck remains queued (handle 30824), UI compilation is unavailable, and no package diagnostics delta is claimed. Three A/B-confirmed neighboring UI failures remain outside this extraction. No retained database, live fixture or QA-stack lifecycle mutation.
