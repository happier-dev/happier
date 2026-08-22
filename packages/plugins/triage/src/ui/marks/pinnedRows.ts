import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import { triageEntryRowKey, type TriageListRowV1 } from '../../projection/listWindow.js';
import { projectTriageEntryDisplay } from '../window/entryDisplay.js';
import type { TriagePinnedEntryV1 } from './pinCommand.js';

/**
 * The overlay of durable pins onto the disposable projection.
 *
 * The two halves have different lifetimes, which is the whole reason this file
 * exists. A pin is Account state that survives restarts, offline daemons and
 * a device that has never walked a source; the entry projection is mount-scoped
 * and may hold nothing at all. So a pin decides that a row exists, and the
 * projection — when it happens to hold that entry — decides what the row says.
 *
 * Matching is on the canonical entry reference and nothing else. It uses the
 * same injective key the window fold and the mark address use, so a pinned
 * entry cannot be paired with a different one whose components merely
 * concatenate to the same string.
 */

/** One row as the list renders it, whether it came from a pass or from a mark. */
export type TriageListDisplayRowV1 = Readonly<{
  /** Stable list identity across re-reads; injective over the canonical ref. */
  key: string;
  entryRef: TriageEntryRefV1;
  title: string;
  scopeLabel: string;
  /** The quiet trailing line: why it needs the reader, or why it cannot be shown. */
  detail: string | null;
  tone: 'neutral' | 'warning' | 'danger';
  pinned: boolean;
  /** Whether this mount's projection holds the entry this row names. */
  materialized: boolean;
  /**
   * The configured instance whose detail this row opens, or `null` when this
   * mount holds no present observation to open one through.
   *
   * It is carried on the row rather than resolved when the row is pressed
   * because qualification is a Corpus decision the window already made.
   * Re-deriving it in the shell would be a second selector, and picking "the
   * first instance" at press time is exactly how a row opens a different
   * connection than the one it is showing.
   */
  sourceInstanceId: string | null;
}>;

/**
 * A pinned row that no current pass materialized says so in the surface's own
 * freshness vocabulary rather than by looking like an ordinary row with a
 * missing subtitle.
 */
const UNMATERIALIZED_PIN_DETAIL = 'Not yet synchronized';

export function indexTriagePinsByEntry(
  pins: readonly TriagePinnedEntryV1[],
): ReadonlyMap<string, TriagePinnedEntryV1> {
  const index = new Map<string, TriagePinnedEntryV1>();
  for (const pin of pins) index.set(triageEntryRowKey(pin.entryRef), pin);
  return index;
}

/** One projected pass row, told whether the reader has pinned it. */
export function projectTriageWindowRow(
  row: TriageListRowV1,
  pins: ReadonlyMap<string, TriagePinnedEntryV1>,
): TriageListDisplayRowV1 {
  const display = projectTriageEntryDisplay(row);
  return Object.freeze({
    key: display.key,
    entryRef: row.entryRef,
    title: display.title,
    scopeLabel: display.scopeLabel,
    detail: display.detail,
    tone: display.tone,
    pinned: pins.has(display.key),
    materialized: true,
    sourceInstanceId: row.selected.kind === 'selected' ? row.selected.sourceInstanceId : null,
  });
}

/**
 * One pinned row. `projected` is the pass row for the same entry when this
 * mount has one, and the mark's own display when it does not.
 */
export function projectTriagePinnedRow(
  pin: TriagePinnedEntryV1,
  projected: TriageListRowV1 | null,
): TriageListDisplayRowV1 {
  if (projected !== null) {
    const display = projectTriageEntryDisplay(projected);
    return Object.freeze({
      key: display.key,
      entryRef: projected.entryRef,
      title: display.title,
      scopeLabel: display.scopeLabel,
      detail: display.detail,
      tone: display.tone,
      pinned: true,
      materialized: true,
      sourceInstanceId: projected.selected.kind === 'selected'
        ? projected.selected.sourceInstanceId
        : null,
    });
  }
  return Object.freeze({
    key: triageEntryRowKey(pin.entryRef),
    entryRef: pin.entryRef,
    title: pin.displayAtMark.title,
    scopeLabel: pin.displayAtMark.scopeLabel,
    detail: UNMATERIALIZED_PIN_DETAIL,
    tone: 'neutral',
    pinned: true,
    materialized: false,
    // A pin this mount never materialized names no present observation, so
    // there is nothing to open and the row must not pretend otherwise.
    sourceInstanceId: null,
  });
}
