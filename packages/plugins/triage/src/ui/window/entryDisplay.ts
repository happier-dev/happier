import {
  formatTriageTimestampV1,
  type TriageSourceEntrySnapshotV1,
  type TriageSourceDescriptorV1,
  type TriageEntryRefV1,
} from '@happier-dev/triage-protocol/v1';

import { triageEntryRowKey, type TriageListRowV1 } from '../../projection/listWindow.js';
import { readTriageAttentionReasonIconV1 } from '../../corpus/attention/deriveAttention.js';

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

/**
 * How this projection resolves the words it authors itself.
 *
 * Structurally the same resolver the rest of the surface uses
 * (`ui/shell/windowState.ts`), declared here rather than imported so a
 * projection every non-UI reader also calls — the search Action, the Composer
 * picker's facts — does not pull the shell in behind it. Provider text is never
 * passed through it: a source's own title, summary and state word are quoted
 * verbatim, because they are the source's statement and not ours to translate.
 */
export type TriageEntryDisplayTextV1 = (key: string, fallback?: string) => string;

const ENGLISH_TEXT: TriageEntryDisplayTextV1 = (_key, fallback = '') => fallback;

/**
 * The closed presentation vocabulary in the reader's own words.
 *
 * It is only ever a fallback. A source that named its own state — "Open",
 * "Merged", "Ignored" — is quoted, because the five-member enum is a lossy
 * projection of the provider's real lifecycle and announcing "Active" over a
 * merged pull request would be less true than the word the source sent.
 */
const LIFECYCLE_COPY_V1: Readonly<Record<
  TriageSourceEntrySnapshotV1['state']['presentation'],
  Readonly<{ key: string; fallback: string }>
>> = Object.freeze({
  active: Object.freeze({ key: 'plugins.triage.surface.row.state.active', fallback: 'Active' }),
  resolved: Object.freeze({ key: 'plugins.triage.surface.row.state.resolved', fallback: 'Resolved' }),
  closed: Object.freeze({ key: 'plugins.triage.surface.row.state.closed', fallback: 'Closed' }),
  suppressed: Object.freeze({ key: 'plugins.triage.surface.row.state.suppressed', fallback: 'Suppressed' }),
  unknown: Object.freeze({ key: 'plugins.triage.surface.row.state.unknown', fallback: 'State unknown' }),
});

/**
 * `attention` is a required-attention reason (the row's one loud fact);
 * `suggestion` is a suggested-attention reason, said quietly.
 */
export type TriageEntryDetailKindV1 = 'presence' | 'attention' | 'suggestion' | 'summary';

export type TriageEntryDisplayV1 = Readonly<{
  /** Stable list identity across re-reads; injective over the canonical ref. */
  key: string;
  title: string;
  scopeLabel: string;
  /** Source-authored readable address; never decoded into routing or identity. */
  identifierLabel: string;
  /** The source's bounded semantic summary, independent of the row status line. */
  summary: string | null;
  /**
   * The row's quiet trailing line: why it needs the reader, or why it cannot
   * currently be shown. `null` is an ordinary row with nothing to add.
   */
  detail: string | null;
  /** Whether the row's presence is a caution rather than ordinary content. */
  tone: 'neutral' | 'warning' | 'danger';
  /**
   * What `detail` is: a presence note, an attention reason, or the source's
   * quiet summary. `null` when there is no detail.
   */
  detailKind: TriageEntryDetailKindV1 | null;
  /** An attention reason's chip mark (a shared icon token name), or `null`. */
  detailIcon: string | null;
  /**
   * Who opened the entry: "You" when the reader did, else the source's author
   * name, else `null` (a kind with no author, or a source that did not say).
   */
  authorLabel: string | null;
  /** The entry's short native designation ("#2481", "!88"), or `null` when its source names none. */
  designation: string | null;
  /** The lifecycle presentation behind `lifecycleLabel`, for the row's mark. */
  lifecyclePresentation: TriageSourceEntrySnapshotV1['state']['presentation'] | null;
  /**
   * The provider's own last-activity moment, when it reports one. It is a
   * display fact only (the source's clock) and decides nothing.
   */
  activityAtMs: number | null;
  /**
   * The source's own kind id for this entry, exactly as the canonical reference
   * carries it. A reader moving row by row hears no section heading and sees no
   * icon, so the kind travels with the row (`core/SURFACE.md` §7.1).
   */
  kindId: string;
  /**
   * The entry's lifecycle in one word, or `null` when no connection reports the
   * entry at all and there is therefore no lifecycle to state.
   */
  lifecycleLabel: string | null;
  /**
   * When this row was last observed, on our clock, or `null` when nothing was
   * ever observed for it. It is the basis of the row's freshness announcement
   * and is never compared with a provider timestamp.
   */
  observedAtMs: number | null;
}>;

/**
 * `absent` and `unresolved` are said in words rather than by omission: a row
 * that quietly loses its title reads as a rendering fault, while a row that
 * says the source no longer reports it is information the reader can act on.
 */
function presenceDetail(
  row: TriageListRowV1,
  text: TriageEntryDisplayTextV1,
): Readonly<{
  detail: string | null;
  tone: TriageEntryDisplayV1['tone'];
}> {
  switch (row.presence.kind) {
    case 'absent':
      return {
        detail: text('plugins.triage.surface.row.absent', 'No longer reported by the source'),
        tone: 'danger',
      };
    case 'unresolved':
      return {
        detail: text('plugins.triage.surface.row.unresolved', 'Could not be read in the last pass'),
        tone: 'warning',
      };
    case 'present':
      return { detail: null, tone: 'neutral' };
  }
}

export function projectTriageEntryDisplay(
  row: TriageListRowV1,
  text: TriageEntryDisplayTextV1 = ENGLISH_TEXT,
): TriageEntryDisplayV1 {
  const snapshot = row.content?.outcome.snapshot;
  const presence = presenceDetail(row, text);
  // Attention outranks a presence note only when the row is actually present:
  // "your review is requested" over an entry the source no longer reports would
  // send the reader somewhere that is not there.
  const detail = presence.detail ?? row.attention?.reasonLabel ?? snapshot?.summary ?? null;
  const detailKind: TriageEntryDetailKindV1 | null = presence.detail !== null
    ? 'presence'
    : row.attention != null
      ? (row.attention.level === 'required' ? 'attention' : 'suggestion')
      : snapshot?.summary !== undefined && snapshot.summary !== null
        ? 'summary'
        : null;

  const viewer = row.content?.outcome.viewer;
  const authorLabel = viewer?.involvement.includes('author') === true
    ? text('plugins.triage.surface.row.you', 'You')
    : snapshot?.authorLabel ?? null;

  return Object.freeze({
    key: triageEntryRowKey(row.entryRef),
    // The identity-only fallback is deliberately the canonical reference rather
    // than an invented placeholder: with no present observation anywhere, the
    // entry id is the only true thing we know about this row.
    title: snapshot?.title ?? row.entryRef.entryId,
    scopeLabel: snapshot?.scopeLabel ?? row.entryRef.collisionScope,
    identifierLabel: row.content?.outcome.locator.displayPath ?? row.entryRef.entryId,
    summary: snapshot?.summary ?? null,
    detail,
    tone: presence.tone,
    detailKind,
    detailIcon: (detailKind === 'attention' || detailKind === 'suggestion') && row.attention != null
      ? readTriageAttentionReasonIconV1(row.attention.reasonId)
      : null,
    authorLabel,
    designation: snapshot?.designation ?? null,
    lifecyclePresentation: snapshot?.state.presentation ?? null,
    activityAtMs: row.content?.outcome.sourceUpdatedAtMs ?? null,
    kindId: row.entryRef.kindId,
    lifecycleLabel: snapshot === undefined
      ? null
      : snapshot.state.nativeLabel ?? text(
          LIFECYCLE_COPY_V1[snapshot.state.presentation].key,
          LIFECYCLE_COPY_V1[snapshot.state.presentation].fallback,
        ),
    // Presence is the roll-up of every connection's answer for this entry, so
    // it is the row's own last observation moment; the content observation is
    // one connection's. They agree for an ordinary row and presence is the
    // truthful one when they do not.
    observedAtMs: row.presence.observedAtMs ?? row.content?.observedAtMs ?? null,
  });
}

/**
 * The facts a row announcement is composed from.
 *
 * Structural rather than tied to either surface's row type, because the same
 * sentence has to be available to the shell list and to any other surface that
 * renders these rows. `stale` is the window's own freshness claim
 * (`ui/shell/windowState.ts`), not a second judgment made per row: one owner
 * decides whether what is on screen is current, and the row states it.
 */
export type TriageEntryRowAnnouncementFactsV1 = Readonly<{
  kindId: string;
  scopeLabel: string;
  lifecycleLabel: string | null;
  detail: string | null;
  observedAtMs: number | null;
  stale: boolean;
  /** The same declared source/kind/address context shown in the row. */
  contextDescription?: string;
  /** The row's visible last-activity age, said in the same place it is shown. */
  activityLabel?: string;
  /** The table's Signal cell ("2 failing"), which a reader walking rows never reaches on its own. */
  signalLabel?: string;
  /** The table's Agent cell: what the linked agent is doing ("Needs your permission"). */
  agentLabel?: string;
}>;

/** Compact scan context for every mounted reader of the canonical display facts. */
export function readTriageEntryRowContextV1(
  facts: Readonly<{
    kindId: string;
    scopeLabel: string;
    identifierLabel?: string;
    lifecycleLabel: string | null;
  }>,
  descriptor?: TriageSourceDescriptorV1 | null,
  source?: TriageEntryRefV1['source'],
): Readonly<{ label: string; description: string }> {
  const kind = descriptor?.kinds.find((candidate) => candidate.id === facts.kindId);
  const sourceLabel = descriptor?.displayName
    ?? (source === undefined ? null : `${source.pluginId}/${source.localId}`);
  const context = [
    ...(sourceLabel === null ? [] : [sourceLabel]),
    kind?.displayName ?? facts.kindId,
    facts.identifierLabel ?? facts.scopeLabel,
  ];
  return {
    label: [...context, ...(facts.lifecycleLabel === null ? [] : [facts.lifecycleLabel])].join(' · '),
    description: context.join(', '),
  };
}

/**
 * What a reader who cannot see the row is told about it, in one place.
 *
 * The row's accessible NAME is the entry and only the entry, so everything else
 * a sighted reader takes from the row's surroundings — which kind of thing it
 * is, which lifecycle it is in, and whether what they are looking at is still
 * current — has to be said here or not at all. `core/SURFACE.md` §7.1 requires
 * exactly that, and requires the stale state to be said in words rather than
 * left to opacity, tone or a timestamp.
 *
 * The title is deliberately absent: a row that announces its own name twice is
 * the failure the pinned name exists to prevent.
 *
 * `, ` is the separator the platforms this description reaches compose their
 * own multi-part announcements with; it is punctuation, not copy.
 */
export function readTriageEntryRowAnnouncementV1(
  facts: TriageEntryRowAnnouncementFactsV1,
  options: Readonly<{
    nowMs: number;
    locale: string;
    text?: TriageEntryDisplayTextV1;
  }>,
): string {
  const text = options.text ?? ENGLISH_TEXT;
  const parts: string[] = facts.contextDescription === undefined
    ? [facts.kindId, facts.scopeLabel]
    : [facts.contextDescription];
  if (facts.lifecycleLabel !== null) parts.push(facts.lifecycleLabel);
  if (facts.activityLabel !== undefined) parts.push(facts.activityLabel);
  if (facts.detail !== null) parts.push(facts.detail);
  if (facts.signalLabel !== undefined) parts.push(facts.signalLabel);
  if (facts.agentLabel !== undefined) parts.push(facts.agentLabel);
  if (facts.stale) {
    // An age is only stated when one is actually known. A row nothing has ever
    // observed is still stale, and inventing a moment for it would be the one
    // freshness claim this surface must never make.
    parts.push(facts.observedAtMs === null
      ? text('plugins.triage.surface.row.stale', 'Stale')
      : `${text('plugins.triage.surface.row.staleSince', 'Stale, last seen')} ${
        formatTriageTimestampV1(options.locale, facts.observedAtMs, 'relative', options.nowMs)
      }`);
  }
  return parts.join(', ');
}
