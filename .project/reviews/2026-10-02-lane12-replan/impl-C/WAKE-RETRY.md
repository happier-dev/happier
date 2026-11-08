IMPLEMENTED_NOT_VERIFIED — source GREEN; live refusal replay and touched-file typecheck remain owed.

RELOAD: UI only. No server/daemon change, restart or PAY.
Verified source cause: Inbox admitted only failed wake authorizations; successful activation retires that authorization before the continuation fails. The blocked-delivery presenter then treated `provider_rejected_before_acceptance` as a temporary provider outage.
This is not `retryable:false` hiding Retry or a missing attention reason: existing `pending_blocked` attention remains unchanged. Native refusal production remains correct (MACH-ISO 92562b9d6f).
Incident limit: QB129 R100 did not observe `codex_continuation_unreachable`; the exact typed-shape regression below is constructed, not a claimed replay of that run.
Fix: `sessionRuntimeIssuePresentation` owns the continuation-unavailable sentence and `new_session` recovery; `pendingMessageVisualState` ties it to blocked delivery. `useSessionPendingActivationPresentation` supplies one decision to composer and Inbox.
Composer offers existing “New session with same setup” through `session.authoring.open`; Inbox offers existing Open through `session.open` without resume intent. Neither retries the unavailable conversation. The transcript's duplicate generic notice is suppressed.

| Evidence | Result |
| --- | --- |
| Constructed exact refusal RED | 2 intended failures / 26 tests: null presentation and rejected Inbox admission (`red.log`). |
| Focused GREEN | 85 presenter/Inbox/banner/pending tests + 6 adjacent authoring/recovery tests + 1 real SessionView action test = 92 passed (`green.log`, `adjacent.log`, `composer-green.log`); 63 shell cases intentionally unselected. |
| Composer check correction | First integration run navigated correctly but asserted nonexistent `prompt`; corrected to canonical draft `input` (`composer.log`). |
| Entry-loads | 7/7 passed, exit 0 (`entry-loads.log`); no foreign-load-break exception needed. |
| Touched-file typecheck | Exit 2 before compilation: invalid shared `.project/tmp/systemic-orch/ui-1104b.locs` baseline; no touched diagnostics or package delta available (`touched-typecheck.log`). |
| Live | Not run: no retained exact-refusal fixture; QA stack lifecycle/Stop/Start stays with the orchestrator. |

Evidence directory: `impl-C/qa-shots5/gaps/wake-retry/` (logs retained outside the source commit).
Same-shape sweep: successful activation followed by typed continuation refusal bypasses recovery — 3 sites: fixed blocked-delivery presentation, Inbox admission and composer consumption / routed native producer through the existing runtime-issue presenter; no second recovery owner retained.
Net mechanism delta: +1 typed-code presentation / −1 duplicate composer resolution; recovery variants +1/−0; authority checks, codes, timers, retries and source files +0/−0. Existing fields only; Inbox refusal causes 0 managed reads (tested).
Touched paths (all under `apps/ui/sources/components/`):
- `sessions/presentation/sessionRuntimeIssuePresentation.ts` and `.test.ts`
- `sessions/pending/pendingMessageVisualState.ts`, `sessions/pending/useSessionPendingActivationPresentation.ts`
- `sessions/composer/useSessionComposerController.tsx`, `sessions/shell/view/resolveSessionViewConnectionStatus.ts`
- `sessions/shell/SessionView.sendMessage.resumeInactive.pendingQueue.test.tsx`
- `inbox/sessionAttention/InboxManagedWakeSessionRow.tsx` and `.test.tsx`
Documentation: no contract change; existing diagnostic/recovery presentation only. Requested report added; no new layout.
Residual risk: reload UI and replay the exact refusal on QA B (desktop/phone); integration owner must restore the shared baseline and run the touched/package typecheck. Source tests do not certify those unavailable checks.
