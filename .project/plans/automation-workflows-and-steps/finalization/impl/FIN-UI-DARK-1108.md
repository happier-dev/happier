DONE (source + commit) — F161A-2 dark-mode ink fixed and committed; live dark recapture at 1440/390 owed to FIN after the next fin2 reload.

## Cause
App `Text` (`apps/ui/sources/components/ui/text/Text.tsx`) paints no colour of its own; it applies only the type role. A bare `<Text>` therefore falls back to the host default (black on web). The announcement at `WorkflowReviewCard.tsx:390` and the generation lines at `:403`/`:405` had no `style`, while the surrounding card text used the card's Unistyles `secondary`/`value` keys. No hardcoded colour or missing theme hook was involved; the token was just never applied.

## Fix (theme tokens through each file's existing stylesheet)
| Surface | Change |
|---|---|
| `run/WorkflowReviewCard.tsx` | `value` key renamed to `primary` (`text.primary`), now also on newer-result announcement, generating-attempt, generation-requested, proposal label |
| `run/WorkflowRunContent.tsx` | phone review-sheet subtitle (with hold navigation) → new `sheetSubtitle` (body, `text.secondary`, modal header subtitle role); hold position / next hold → `provenance` (meta, `text.secondary`) instead of bare `variant="meta"` |
| `run/workflowRunStyles.ts` | `+sheetSubtitle` |
| `screens/WorkflowRunScreen.tsx` | `+notice` (`text.secondary`) for "content unavailable" and the accepted-while-paused feedback |
| `run/WorkflowRunRoles.tsx` | new local stylesheet `primary` for role catalog loading/failure, engine change, engine and runs-as values |

## Checks
| Check | Verdict | Evidence |
|---|---|---|
| `WorkflowReviewCard.test.tsx` + `WorkflowRunRoles.test.tsx` (hstack-exec vitest) | PASS 37/37 | lane transcript |
| entry-loads (hstack-exec, current source) | PASS 7/7, rc=0 | `apps/stack/scripts/perf/entry-load.mjs` |
| Live dark capture | NOT RUN | needs the next fin2 reload (no stack lifecycle in this lane) |

## Residual
- Same bare-`Text` pattern remains outside the run/review corridor (not touched, not review surfaces): `editor/WorkflowRolesEditor.tsx:50,88`, `triggers/TriggerPluginEventRows.tsx:126`, `editor/WorkflowLoopEditor.tsx:372` (wrapper; child may set ink), `editor/WorkflowStepDataEditor.tsx:91` (inline literal, likely inherits from its sentence). Root cause is app-wide: `Text` has no default ink. A default `text.primary` in `Text` would close the class but changes nested-inheritance behaviour app-wide; that is a Text-owner decision, not taken here.
- `workflowRunStyles.ts` carries foreign uncommitted hunks; the commit includes only the `sheetSubtitle` hunk.
