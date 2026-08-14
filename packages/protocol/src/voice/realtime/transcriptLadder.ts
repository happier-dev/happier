import {
  VoiceTranscriptCanonicalEventV1Schema,
  type VoiceTranscriptCanonicalEventV1,
} from './events.js';

/**
 * How a provider observation relates to the transcript of one conversation item.
 *
 * - `delta` — an incremental fragment appended to the item's running text.
 * - `updated` — a full interim transcript that replaces the item's running text.
 * - `final` — the provider's authoritative transcript for the item. Realtime
 *   providers may emit this more than once for the same item, each one
 *   superseding the previous.
 */
export type VoiceTranscriptLadderMode = 'delta' | 'updated' | 'final';

export type VoiceTranscriptLadderObservation = Readonly<{
  itemId: string;
  eventId: string;
  role: 'user' | 'assistant';
  /**
   * The text this observation carries: the fragment for a `delta`, the whole
   * transcript for `updated`/`final`.
   *
   * Absent or `null` means the provider event carried no text of its own. Some
   * wires signal completion of an item without restating it; a `final` with no
   * text therefore seals the text the ladder already accumulated for the item
   * rather than erasing it, and a textless interim observation is ignored.
   */
  incoming?: string | null;
  mode: VoiceTranscriptLadderMode;
  provenance?: 'live' | 'replay';
}>;

export type VoiceTranscriptLadderMapper = Readonly<{
  /** Start a new provider conversation: a fresh epoch with no carried-over items. */
  beginConversation(): number;
  /**
   * Fold one provider observation into the item's transcript, returning the
   * canonical event to publish or `null` when the observation changes nothing.
   */
  map(observation: VoiceTranscriptLadderObservation): VoiceTranscriptCanonicalEventV1 | null;
}>;

const DEFAULT_MAX_ITEMS = 2_048;

type LadderItemState = Readonly<{ text: string; revision: number; final: boolean }>;

const EMPTY_ITEM_STATE: LadderItemState = Object.freeze({ text: '', revision: 0, final: false });

/**
 * Canonical owner of the realtime provider transcript ladder.
 *
 * Realtime providers stream one conversation item as a ladder of observations:
 * interim fragments/updates, then one or more authoritative finals. This mapper
 * folds that ladder into the canonical {@link VoiceTranscriptCanonicalEventV1}
 * stream that the host transcript projector consumes, keyed on the provider's
 * own item identity so a superseding transcript corrects the existing row
 * instead of appending another one.
 *
 * It is the single owner of that rule for every provider whose wire has this
 * shape; provider leaves only classify their native event types into a
 * {@link VoiceTranscriptLadderMode} and hand over the provider identities.
 */
export function createVoiceTranscriptLadderMapper(
  options?: Readonly<{ maxItems?: number }>,
): VoiceTranscriptLadderMapper {
  const maxItems = Number.isFinite(options?.maxItems) && Number(options?.maxItems) > 0
    ? Math.max(1, Math.floor(Number(options?.maxItems)))
    : DEFAULT_MAX_ITEMS;
  const items = new Map<string, LadderItemState>();
  let epoch = 0;
  let sequence = 0;

  /** Start a new provider conversation: a fresh epoch with no carried-over items. */
  const beginConversation = (): number => {
    epoch += 1;
    sequence = 0;
    items.clear();
    return epoch;
  };

  const map = (
    observation: VoiceTranscriptLadderObservation,
  ): VoiceTranscriptCanonicalEventV1 | null => {
    const previous = items.get(observation.itemId) ?? EMPTY_ITEM_STATE;
    // A provider-final transcript is authoritative for its item. A later
    // non-final observation is a late interim event that the provider already
    // superseded: honoring it would either regress the row to a partial
    // transcript or concatenate a trailing delta onto the completed sentence.
    // Only another provider-final may correct an item that is already final.
    if (previous.final && observation.mode !== 'final') return null;
    const incoming = observation.incoming ?? null;
    const nextText = incoming === null
      ? previous.text
      : observation.mode === 'delta'
        ? `${previous.text}${incoming}`
        : incoming;
    if (nextText === previous.text && (observation.mode !== 'final' || previous.final)) return null;
    const correction = previous.final && nextText !== previous.text;
    const revision = previous.revision + 1;
    const final = observation.mode === 'final' || correction;
    items.set(observation.itemId, { text: nextText, revision, final });
    while (items.size > maxItems) {
      const oldest = items.keys().next();
      if (oldest.done) break;
      items.delete(oldest.value);
    }
    const type = correction
      ? 'voice.transcript.corrected'
      : final ? 'voice.transcript.final'
        : observation.mode === 'delta' ? 'voice.transcript.delta' : 'voice.transcript.updated';
    return VoiceTranscriptCanonicalEventV1Schema.parse({
      v: 1,
      type,
      epoch,
      sequence: ++sequence,
      revision,
      eventId: observation.eventId,
      itemId: observation.itemId,
      role: observation.role,
      text: observation.mode === 'delta' && !correction && incoming !== null ? incoming : nextText,
      provenance: observation.provenance ?? 'live',
    });
  };

  return Object.freeze({ beginConversation, map });
}
