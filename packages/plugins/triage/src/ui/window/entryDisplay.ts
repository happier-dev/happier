import { triageEntryRowKey, type TriageListRowV1 } from '../../projection/listWindow.js';

/**
 * The one display projection of a window row.
 *
 * The shell list and the Composer picker show the same entries, so they read
 * the same title, the same owning scope and the same reason line. A second
 * projection would let one surface show a title the other does not, which is
 * exactly the divergence one shared window exists to prevent.
 *
 * It decides no winner of its own, and that is the whole point of the row's
 * `content` member: which observation speaks for a row is decided once by the
 * fold, under `core/CORPUS.md` §3.2's stable-id rule, and read here. This module
 * previously picked the *selected* connection and fell back to whichever
 * connection answered last, while the fold picked the newest answer for the lane
 * and the ordinal — so one row could carry an open entry's title while filing
 * itself under Done, and an `observedAtMs` tie flipped the answer with array
 * order. There is one winner now, and no reader chooses again.
 */

export type TriageEntryDisplayV1 = Readonly<{
  /** Stable list identity across re-reads; injective over the canonical ref. */
  key: string;
  title: string;
  scopeLabel: string;
  /** The source's bounded semantic summary, independent of the row status line. */
  summary: string | null;
  /**
   * The row's quiet trailing line: why it needs the reader, or why it cannot
   * currently be shown. `null` is an ordinary row with nothing to add.
   */
  detail: string | null;
  /** Whether the row's presence is a caution rather than ordinary content. */
  tone: 'neutral' | 'warning' | 'danger';
}>;

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
  const snapshot = row.content?.outcome.snapshot;
  const presence = presenceDetail(row);
  // Attention outranks a presence note only when the row is actually present:
  // "your review is requested" over an entry the source no longer reports would
  // send the reader somewhere that is not there.
  const detail = presence.detail ?? row.attention?.reasonLabel ?? snapshot?.summary ?? null;

  return Object.freeze({
    key: triageEntryRowKey(row.entryRef),
    // The identity-only fallback is deliberately the canonical reference rather
    // than an invented placeholder: with no present observation anywhere, the
    // entry id is the only true thing we know about this row.
    title: snapshot?.title ?? row.entryRef.entryId,
    scopeLabel: snapshot?.scopeLabel ?? row.entryRef.collisionScope,
    summary: snapshot?.summary ?? null,
    detail,
    tone: presence.tone,
  });
}
