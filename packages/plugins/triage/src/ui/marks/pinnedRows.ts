import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import { triageEntryRowKey, type TriageListRowV1 } from '../../projection/listWindow.js';
import {
  projectTriageEntryDisplay,
  type TriageEntryDetailKindV1,
  type TriageEntryDisplayTextV1,
  type TriageEntryDisplayV1,
} from '../window/entryDisplay.js';
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
  /** Source-authored address, or retained scope and opaque identity when unread. */
  identifierLabel?: string;
  /** The quiet trailing line: why it needs the reader, or why it cannot be shown. */
  detail: string | null;
  tone: 'neutral' | 'warning' | 'danger';
  /** What `detail` is, so the row can make an attention reason its one loud fact. */
  detailKind: TriageEntryDetailKindV1 | null;
  /** The attention reason's chip mark (a shared icon token name), or `null`. */
  detailIcon: string | null;
  /** Who opened the entry ("You", a name), for the list's byline; `null` when nobody is known. */
  authorLabel: string | null;
  /** The entry's short native designation ("#2481"), quiet after the title; `null` when its source names none. */
  designation: string | null;
  /** The lifecycle presentation behind `lifecycleLabel`, for the row's mark. */
  lifecyclePresentation: TriageEntryDisplayV1['lifecyclePresentation'];
  /** The provider's own last-activity moment (display only), or `null`. */
  activityAtMs: number | null;
  /**
   * The facts a row draws and announces: what kind of thing
   * it is, which lifecycle it is in, and whether what is on screen is still
   * current (`core/SURFACE.md` §7.1). They are carried on the row rather than
   * re-derived per surface, for the same reason its title is.
   */
  kindId: string;
  lifecycleLabel: string | null;
  observedAtMs: number | null;
  /** The window's own freshness claim about the rows it published. */
  stale: boolean;
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
const UNMATERIALIZED_PIN_DETAIL_KEY = 'plugins.triage.surface.row.notSynchronized';

/**
 * How a projected row is told the things the projection itself cannot know:
 * the reader's own words, and whether the window it came from is current.
 */
export type TriageListRowProjectionOptionsV1 = Readonly<{
  text?: TriageEntryDisplayTextV1;
  stale?: boolean;
}>;

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
  options: TriageListRowProjectionOptionsV1 = {},
): TriageListDisplayRowV1 {
  const display = projectTriageEntryDisplay(row, options.text);
  return Object.freeze({
    key: display.key,
    entryRef: row.entryRef,
    title: display.title,
    scopeLabel: display.scopeLabel,
    identifierLabel: display.identifierLabel,
    detail: display.detail,
    tone: display.tone,
    detailKind: display.detailKind,
    detailIcon: display.detailIcon,
    authorLabel: display.authorLabel,
    designation: display.designation,
    lifecyclePresentation: display.lifecyclePresentation,
    activityAtMs: display.activityAtMs,
    pinned: pins.has(display.key),
    materialized: true,
    sourceInstanceId: row.selected.kind === 'selected' ? row.selected.sourceInstanceId : null,
    kindId: display.kindId,
    lifecycleLabel: display.lifecycleLabel,
    observedAtMs: display.observedAtMs,
    stale: options.stale === true,
  });
}

/**
 * One pinned row. `projected` is the pass row for the same entry when this
 * mount has one, and the mark's own display when it does not.
 */
export function projectTriagePinnedRow(
  pin: TriagePinnedEntryV1,
  projected: TriageListRowV1 | null,
  options: TriageListRowProjectionOptionsV1 = {},
): TriageListDisplayRowV1 {
  if (projected !== null) {
    const display = projectTriageEntryDisplay(projected, options.text);
    return Object.freeze({
      key: display.key,
      entryRef: projected.entryRef,
      title: display.title,
      scopeLabel: display.scopeLabel,
      identifierLabel: display.identifierLabel,
      detail: display.detail,
      tone: display.tone,
      detailKind: display.detailKind,
      detailIcon: display.detailIcon,
      authorLabel: display.authorLabel,
      designation: display.designation,
      lifecyclePresentation: display.lifecyclePresentation,
      activityAtMs: display.activityAtMs,
      pinned: true,
      materialized: true,
      sourceInstanceId: projected.selected.kind === 'selected'
        ? projected.selected.sourceInstanceId
        : null,
      kindId: display.kindId,
      lifecycleLabel: display.lifecycleLabel,
      observedAtMs: display.observedAtMs,
      stale: options.stale === true,
    });
  }
  const text = options.text;
  return Object.freeze({
    key: triageEntryRowKey(pin.entryRef),
    entryRef: pin.entryRef,
    title: pin.displayAtMark.title,
    scopeLabel: pin.displayAtMark.scopeLabel,
    identifierLabel: `${pin.displayAtMark.scopeLabel} · ${pin.entryRef.entryId}`,
    detail: text === undefined
      ? UNMATERIALIZED_PIN_DETAIL
      : text(UNMATERIALIZED_PIN_DETAIL_KEY, UNMATERIALIZED_PIN_DETAIL),
    tone: 'neutral',
    detailKind: 'presence',
    detailIcon: null,
    authorLabel: null,
    designation: null,
    lifecyclePresentation: null,
    activityAtMs: null,
    pinned: true,
    materialized: false,
    // A pin this mount never materialized names no present observation, so
    // there is nothing to open and the row must not pretend otherwise.
    sourceInstanceId: null,
    kindId: pin.entryRef.kindId,
    // No pass materialized this entry, so this mount knows no lifecycle and no
    // observation moment for it. Its own detail already says exactly that, and
    // calling it stale as well would state the same absence twice.
    lifecycleLabel: null,
    observedAtMs: null,
    stale: false,
  });
}
