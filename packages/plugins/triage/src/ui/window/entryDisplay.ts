import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type { ProjectedObservationV1 } from '../../corpus/fold/projectedObservation.js';
import type { TriageListRowV1 } from '../../projection/listWindow.js';

/**
 * The one display projection of a window row.
 *
 * The shell list and the Composer picker show the same entries, so they read
 * the same title, the same owning scope and the same reason line. A second
 * projection would let one surface show a title the other does not, which is
 * exactly the divergence one shared window exists to prevent.
 *
 * It decides no winner of its own. Which connection speaks for a row is already
 * decided by `selectObservationInstance`, and this module reads that decision
 * (`core/CORPUS.md` §6.1); only when the selected instance has retired does it
 * fall back to the newest present observation, so a retired row still shows the
 * entry the user recognizes instead of a bare identifier.
 */

export type TriageEntryDisplayV1 = Readonly<{
  /** Stable list identity across re-reads; injective over the canonical ref. */
  key: string;
  title: string;
  scopeLabel: string;
  /**
   * The row's quiet trailing line: why it needs the reader, or why it cannot
   * currently be shown. `null` is an ordinary row with nothing to add.
   */
  detail: string | null;
  /** Whether the row's presence is a caution rather than ordinary content. */
  tone: 'neutral' | 'warning' | 'danger';
}>;

/**
 * The presentation key of one canonical entry reference.
 *
 * A JSON array encoding rather than a delimiter join, for the same reason the
 * fold in `projection/listWindow.ts` uses one: `U+001F` is representable inside
 * `collisionScope`, so a joined key can merge two contract-valid distinct
 * entries — and two merged rows would put keyboard focus and selection on an
 * entry the reader never chose. JSON string escaping is injective over the
 * ordered components, so this key cannot collide.
 */
export function triageEntryRowKey(entryRef: TriageEntryRefV1): string {
  return JSON.stringify([
    entryRef.source.pluginId,
    entryRef.source.localId,
    entryRef.kindId,
    entryRef.collisionScope,
    entryRef.entryId,
  ]);
}

type PresentOutcomeV1 = Extract<ProjectedObservationV1['outcome'], Readonly<{ kind: 'present' }>>;

function selectedPresentOutcome(row: TriageListRowV1): PresentOutcomeV1 | null {
  if (row.selected.kind !== 'selected') return null;
  const selectedInstanceId = row.selected.sourceInstanceId;
  for (const observation of row.observations) {
    if (observation.sourceInstanceId !== selectedInstanceId) continue;
    if (observation.outcome.kind === 'present') return observation.outcome;
  }
  return null;
}

function newestPresentOutcome(row: TriageListRowV1): PresentOutcomeV1 | null {
  let newest: Readonly<{ observedAtMs: number; outcome: PresentOutcomeV1 }> | null = null;
  for (const observation of row.observations) {
    if (observation.outcome.kind !== 'present') continue;
    if (newest !== null && observation.observedAtMs <= newest.observedAtMs) continue;
    newest = { observedAtMs: observation.observedAtMs, outcome: observation.outcome };
  }
  return newest === null ? null : newest.outcome;
}

/**
 * `absent` and `unresolved` are said in words rather than by omission: a row
 * that quietly loses its title reads as a rendering fault, while a row that
 * says the source no longer reports it is information the reader can act on.
 */
function presenceDetail(row: TriageListRowV1): Readonly<{
  detail: string | null;
  tone: TriageEntryDisplayV1['tone'];
}> {
  switch (row.presence.kind) {
    case 'absent':
      return { detail: 'No longer reported by the source', tone: 'danger' };
    case 'unresolved':
      return { detail: 'Could not be read in the last pass', tone: 'warning' };
    case 'present':
      return { detail: null, tone: 'neutral' };
  }
}

export function projectTriageEntryDisplay(row: TriageListRowV1): TriageEntryDisplayV1 {
  const outcome = selectedPresentOutcome(row) ?? newestPresentOutcome(row);
  const presence = presenceDetail(row);
  // Attention outranks a presence note only when the row is actually present:
  // "your review is requested" over an entry the source no longer reports would
  // send the reader somewhere that is not there.
  const detail = presence.detail ?? row.attention?.reasonLabel ?? outcome?.snapshot.summary ?? null;

  return Object.freeze({
    key: triageEntryRowKey(row.entryRef),
    // The identity-only fallback is deliberately the canonical reference rather
    // than an invented placeholder: with no present observation anywhere, the
    // entry id is the only true thing we know about this row.
    title: outcome?.snapshot.title ?? row.entryRef.entryId,
    scopeLabel: outcome?.snapshot.scopeLabel ?? row.entryRef.collisionScope,
    detail,
    tone: presence.tone,
  });
}
