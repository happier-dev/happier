VERDICT: DONE — F1–F4 fixed at their owners and seen live on #62 (server 038a3337975287df); see commit line below. Visual: seen live by this lane (Opus), not by an independent pass.

ACCEPT-FIX-1110 → RU2, 2026-11-10 07:35–09:55Z. Input: RU2-ACCEPT-1110 F1–F4. Evidence: `.project/tmp/ACCEPT-FIX-1110/` (E); "before" = `.project/tmp/RU2-ACCEPT-1110/` (B).

## Findings
| Finding | Fix (owner) | Test | Live after | Before / after |
|---|---|---|---|---|
| F1a managed picture letterboxed | `BrowserStreamedTarget`: `containRect(..., 'top')`, player drawn in the page rect, so the page fills the pane width from the top. No local scroller: the page scrolls through forwarded wheel/swipe. | `BrowserStreamedTarget.layout.test.tsx` RED (y=231) → GREEN | 1440 light/dark, 390 light: frame at the top, cursor still on the page | B/`browser-pane-1440-light` / E/`after-browser-pane-1440-{light,dark}`, `after-browser-390-light` |
| F1b address squeezed ("example.cc") | In `pane` density the page-size picker folds into the ⋯ as a checked "Device preview" set (`browserViewportChoices` extracted from `BrowserViewportPicker`; `BrowserToolbarOverflowItem` gains `selected`/`group`, drawn by both the toolbar ⋯ and the pane-header ⋯). Wide row and phone bar unchanged. | `BrowserShell.test` "keeps the address its room…" RED → GREEN, plus the existing viewport/N4 tests | "example.com" in full; ⋯ shows Device preview with Fit viewer ✓ | E/`after-browser-pane-1440-light`, `after-browser-menu-1440-light` |
| F2 Secrets prompt was a management list | `SecretRequirementModal`: no rename/replace/delete; the duplicate env-row subtitle removed; a "Manage saved secrets" row (last) closes and opens `/settings/secrets`; card `scrollHost: 'body'` so it keeps its height while searching. `SecretsList` (the owner for every picker): the one `CompactSearchField` past `COLLECTION_LIST_SEARCH_THRESHOLD`, "No matches", names wrap (`titleLines={0}`). | `SecretsList.rowSelection` search test, `SecretRequirementModal.chrome` manage test, RED → GREEN | 1440/390 light/dark; search "api" narrows; "zzqq" → No matches with height held; Manage → `/settings/connected-services/secrets` | B/`sheet-secrets` / E/`after-secrets-*`, `after-secrets-search-1440-light`, `after-secrets-nomatch-1440-light` |
| F3 people link titled "Public link" | `LocalServicePublicPreviewControls`: title from `exposure.mode` (people → "Link for specific people", secret → "Secret link"). The reach line names the audience the exposure holds ("Only QA TH B can open it…") through new `sharing/sharePrincipalNames.ts`, extracted from `approvals/approvalPrincipalReading.ts`, which now delegates to it (one resolver). Footer, revoke confirm and a11y labels are mode-neutral in all 12 locales. | confirm.test "titles a people share…" RED → GREEN | Created a link for QA TH B, then revoked it: 1440 light/dark, 390 light/dark | B/`people-live-crop` / E/`after-people-*`, `before-revoke-confirm-1440-light` |
| F4 header promised "choose where they run" | Source: `ProjectServicePlacementControls` exists and is already wired (Runs on → picker → Move) for services declared `execution: "portable"`. The acceptance's `lumen-docs` is not portable, so its row is correctly a fact ("runs on the primary checkout"). Fix: header copy is now "start them, open them and share them" (all locales). Missing: nothing on the page tells a person how to make a service portable. | copy only | header renders the new line | B/`svc-runs-on-click-1440-light` / E/`svc-page-1440-light` |

## Other rows
- **Extension Remove dialog:** not reachable. Account A has no extension on a saved profile. Owed.
- **Inline chooser open geometry:** not reachable. I have no Session of my own with a pending Computer ask; I didn't open another lane's chooser. Owed.
- **Cleanup:**
  - Project `RU2-ACCEPT-1110-svc` was removed through ⋯ → Remove → "Forget a workspace" (Projects 23 → 22).
  - **Finding:** the folder `~/RU2-ACCEPT-1110-svc` on NLDW4 is still there. Remove only forgets, and I found no product control or Action that deletes the folder. I left it, as the brief says.
  - Service `lumen-docs` was stopped through the product, and the people link was revoked. Browser `ACCEPT-FIX-1110` (nl1, PID 3672159) is closed; its CDP port is refused.
- **Copy P3 (not fixed):** the forget dialog reads "Forget a workspace · This Home", in Projects' owner.

## Checks
| Check | Result |
|---|---|
| Focused RED→GREEN (F1a, F1b, F2×2, F3) | GREEN. Final run: secrets 13/13, BrowserStreamedTarget 1/1, BrowserShell filtered 6/6, confirm.test 17/18 (the 1 fails on HEAD bytes too) |
| Entry-loads | 13/13 passed on the final bytes |
| TS parse of every touched file | ok |
| Typecheck | not run (brief) |
| Unattributed failures | `ApprovalDetailScreen` "preserves principal…" ×2 also fail on HEAD bytes (A/B); `useSavedSecretCatalog` ×2, `useActionApprovalContinuation`, `LocalPreviewTarget.web`, `BrowserAgentCursor` (import: `Surface` undefined), and `confirm.test` "registers a running Sessionless Service" are in files or paths I didn't change |
| Note | `a9b06204cf` (voice) already carried my first translation hunks; this commit adds the rest by hunk. |
| Incident | My scripted edit to `BrowserToolbarOverflowMenu.tsx` was briefly unparseable (08:46Z). Coordination repaired it at 08:49Z; the current bytes are my intended change and parse. |

## Residual risk
- At 390, the agent cursor was seen once just below the frame; the desktop mapping is consistent. Not reproduced.
- The managed page still reads small at pane width: its size is the agent's 1280-wide viewport. "Device preview" or Take control resizes it.
- A people share whose names can't resolve keeps the generic people sentence.
- The new copy in the 11 other locales was written by me, not by translators.
- Mechanism delta: +1 module (`sharePrincipalNames.ts`, replacing the approvals-local reader), +2 optional overflow-item fields, +1 SecretsList search state; −1 duplicated resolver body.

Model trial: Opus 5.5 (claude-opus-5-5), effort low; surfaces Browser pane, Secrets prompt, Services share block, Services header; review rounds: 0 (awaiting acceptance); usage limit: not hit.
