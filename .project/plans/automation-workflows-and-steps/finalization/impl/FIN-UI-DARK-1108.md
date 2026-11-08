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

## Round 2 (coordinator: editor + triggers + full sweep)
| Surface | Change |
|---|---|
| `editor/WorkflowRolesEditor.tsx:50,88` | new local stylesheet `primary` on role catalog failure and per-role loading/unavailable lines |
| `triggers/TriggerPluginEventRows.tsx:93` | event-ref subtitle node (Item renders element subtitles as-is) → `eventRef` (mono, `text.secondary`) |
| `triggers/TriggerPluginEventRows.tsx:126` | event test result → `testResult` (`text.primary`) |
| `run/WorkflowRunComposer.tsx:745` | roles prefill loading/failed → existing `body` (`text.primary`) |

Sweep of `components/workflows/**` (every `<Text` tag, multi-line aware; style keys resolved against the file's and imported local stylesheets). Not changed, verified coloured:
- `WorkflowLoopEditor.tsx:372` passes into `WorkflowBlockHeading` `meta`, wrapped in a Text with `headingMeta`/`headingName` (both coloured).
- `WorkflowStepDataEditor.tsx:91` literal token is reached only from `WorkflowReferenceSentence`, whose callers all sit inside coloured Text (heading meta, `laneLabel`, `metaText`). The `:211` caller handles literals itself.
- `WorkflowBlockListEditor.tsx:768` goes to heading `meta` or lane `content`, rendered inside `laneLabel` Text.
- `WorkflowProjectTargetControl.tsx:250` nested in `styles.fixed` (`text.secondary`). `WorkflowResultFieldsEditor` `label`/`labelStacked` and `quietAction` carry colour.
- `WorkflowStepOptionsChip` gets the chip host's `textStyle`. The `WorkflowRunFoldHeader` host Text gets coloured styles from the plugin-ui owner. `TriggerRow` uses the row subtitle or `workStatusWordStyle` ink.

## Residual
- Root cause stays app-wide: `Text` has no default ink. Not changed, because in React Native a nested Text would override its parent's colour (coordinator agreed). New bare `<Text>` can reintroduce this anywhere.
- `workflowRunStyles.ts` carries foreign uncommitted hunks. Commit 7185beabfe includes only the `sheetSubtitle` hunk.

Commit: 7185beabfe (private index, CAS on read-tree base; diff-tree lists only the 6 lane paths).

Model trial: Opus 5.5, low effort; surface Workflow run/review/editor/trigger dark ink; 1 coordinator round (scope widening, no rework); no usage limit hit.
