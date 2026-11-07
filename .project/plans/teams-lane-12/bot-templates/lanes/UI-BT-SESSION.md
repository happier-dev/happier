IMPLEMENTED_NOT_VERIFIED — F6 and F10 fixed at their owners and seen live on d2 (1440 light, 390 dark); focused tests green. Owed: entry-loads 7/7 and UI typecheck delta (running at report time), then the fast-path commit. Opus whole-page acceptance by a different reviewer is still owed.

| Finding | Verdict | Evidence |
|---|---|---|
| F6 first-run seed renders as the person's bubble and fails as "Blocked" | FIXED | Pending seed rows are classified once at the presentation owner (`pendingMessageVisualState.ts` `hostOnboarding`, via `hostAuthoredInput.ts#isHostOnboardingInputMeta`, which MessageView's committed path now also uses). The row draws through the shared transcript event row (the same meta line as the committed seed), with no status chip, no blocked notice (`heightBearingChrome: 'none'`, so the measurement signature agrees), and no Copy, Edit or Send as new. Remove, Mark handled and Send now stay on hover only, so a blocked seed can still be cleared. The failure is said once by the Session's own status line. Live: `.project/tmp/UI-BT-SESSION/after-born-1440-light.png`, `after-born-390-dark.png`; before `.project/tmp/REAL-USER-PASS/j2-born-30s-1440-light.png` |
| F10 Bot rows and tabs show an Agent glyph or "U" | FIXED | `SessionListIdentity` draws a Bot's face on every identity display (it was avatar mode only). The window tab strip gets the face from the row it already selects (`useDestinationInstanceTabPresentations` → `DocumentTabPresentation.mark`; element reused until the seed or saved face changes). The phone open-tabs rail (`PhoneOpenTabsRail#RailSessionMark`) draws the face from the Session it already reads. No new reads. Live: `after-home-1440-light.png`, `after-home-390-dark.png`; before `j9-row-hover-1440-light.png` |
| RED → GREEN | GREEN | `pendingMessageVisualState.test.ts` (first-run seed), `SessionListIdentity.test.tsx` (every identity display), `useDestinationInstanceTabPresentations.test.tsx` (Bot tab face, stable identity), `PhoneOpenTabsRail.test.tsx` (Bot tab face). Each failed first for the intended reason. `MessageView.attribution.test.tsx` passes (onboarding cases included) |
| Entry loads | OWED | running |
| UI typecheck | OWED | running |

Accepted differences from the lab (`r2-install-first-light.png`): the seed line uses the shared transcript event row (left-aligned, info glyph), not the lab's centred document-glyph line with "· just now". Changing that renderer would change every event row, so it was left as is. The Bot's greeting and first-task chip need an agent turn, and QA agent quota is exhausted.

Unattributed failures observed (not caused by this lane; every new branch is a no-op unless the row is a first-run seed): `PendingMessagesTranscriptBlock.test.tsx` (25 cases, for example the hover reveal expects pointerEvents `none`), `PendingMessagesTranscriptBlock.discardFallback` and `exactHomeAuthorship` (60 s timeouts under load), and 3 status cases in `useDestinationInstanceTabPresentations.test.tsx` (status undefined; the hook and `sessionUtils.ts` carry foreign edits).

Mechanism delta: +1 predicate `isHostOnboardingInputMeta` (it replaces MessageView's inline copy, so one owner decides), +1 presentation field `hostOnboarding`, +1 generic tab-presentation slot `mark`. No reads, timers, polls, caches or settings were added.

Residual risk:
- A pending seed's identity comes from its authored metadata, because the Home receipt carries no producer. Only the Session owner can admit one through the onboarding route. A look-alike queued by a shared editor keeps that editor's byline.
- The phone cockpit "Chat" tab still shows the Agent identity ("U"). It is the Session's pane bar rather than My work, and `SessionCockpitTabBar.tsx` carries large foreign edits.

Model trial: claude-opus-5-5, effort low/medium (lane default); surface Bot first-run transcript + My work rows/tabs; review rounds: 0 so far (acceptance owed); usage limit: not hit.

SHA: pending.
