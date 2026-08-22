import type { TriageEntryRefV1, TriageSourceInstanceIdV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageSurfaceStateV1 } from './surface.js';

export type TriageActionTargetV1 =
  | Readonly<{
      kind: 'entry';
      /** `null` when the selected entry has no row on this page; see the reducer's own selection type. */
      sectionId: string | null;
      entryRef: TriageEntryRefV1;
      sourceInstanceId: TriageSourceInstanceIdV1;
    }>
  | Readonly<{ kind: 'refused'; reason: 'noSelectedEntry' }>;

const NO_SELECTED_ENTRY: TriageActionTargetV1 = Object.freeze({
  kind: 'refused',
  reason: 'noSelectedEntry',
});

/**
 * The ONE aggregate action-target reader (`core/SURFACE.md` §3.1).
 *
 * It reads `selection`, never `focus`. The header's Ask / Fix / review controls
 * and the entry-targeted user-mark action all act on the entry whose detail is
 * actually on screen, so a keyboard cursor parked on a different row can never
 * redirect a mutation. No selection is a typed refusal the caller renders with
 * an accessible reason; it never silently falls back to the focused or first row.
 */
export function resolveTriageActionTargetV1(state: TriageSurfaceStateV1): TriageActionTargetV1 {
  const selection = state.selection;
  if (selection === null) return NO_SELECTED_ENTRY;
  return Object.freeze({
    kind: 'entry',
    sectionId: selection.sectionId,
    entryRef: selection.entryRef,
    sourceInstanceId: selection.sourceInstanceId,
  });
}
