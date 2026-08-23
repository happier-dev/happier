import { createVoiceTranscriptLadderMapper } from '@happier-dev/plugin-sdk/voice/client';
import type { VoiceTranscriptCanonicalEvent } from '@happier-dev/plugin-sdk/voice';

/**
 * The canonical transcript id contract is 256 characters. The leaf composes
 * `elevenlabs:message:<providerEventId>` and the ladder then derives an event
 * identity from it, so the provider half is bounded well inside that ceiling —
 * an identity that cannot produce a canonical event is not usable transcript
 * identity, and the message is dropped rather than published unvalidated.
 */
const ITEM_ID_PREFIX = 'elevenlabs:message:';
const MAX_PROVIDER_EVENT_ID_LENGTH = 200;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readRole(record: Readonly<Record<string, unknown>>): 'user' | 'assistant' | null {
  if (record.role === 'user' || record.source === 'user') return 'user';
  if (record.role === 'agent' || record.source === 'ai') return 'assistant';
  return null;
}

function readTrimmedText(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function readProviderEventId(record: Readonly<Record<string, unknown>>): string | null {
  const value = record.event_id;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string' || !value || value.trim() !== value) return null;
  return value.length > MAX_PROVIDER_EVENT_ID_LENGTH ? null : value;
}

type ProviderObservation = Readonly<{
  role: 'user' | 'assistant';
  text: string;
  providerEventId: string;
}>;

function readMessageObservation(
  record: Readonly<Record<string, unknown>>,
): ProviderObservation | null {
  const role = readRole(record);
  const text = readTrimmedText(record.message);
  const providerEventId = readProviderEventId(record);
  return role && text && providerEventId ? { role, text, providerEventId } : null;
}

/**
 * ElevenLabs does not restate a corrected agent turn as a second
 * `agent_response`: it publishes an `agent_response_correction` client event
 * carrying the whole corrected turn under the original turn's `event_id`.
 * Reading that envelope into the same role/text/identity triple is what lets the
 * shared ladder recognise the restatement it already knows how to correct.
 */
function readCorrectionObservation(
  record: Readonly<Record<string, unknown>>,
): ProviderObservation | null {
  if (record.type !== 'agent_response_correction') return null;
  const correction = readRecord(record.agent_response_correction_event);
  if (!correction) return null;
  const text = readTrimmedText(correction.corrected_agent_response);
  const providerEventId = readProviderEventId(correction);
  return text && providerEventId ? { role: 'assistant', text, providerEventId } : null;
}

/**
 * ElevenLabs-native transcript classification.
 *
 * The leaf only reads the provider's wire: which role a message belongs to,
 * what text it carries, and which conversation item it identifies. Epoch,
 * sequence, revision, correction and duplicate suppression are the canonical
 * transcript ladder's, exactly as they are for every other realtime provider.
 *
 * ElevenLabs restates a whole message rather than streaming fragments, so every
 * classified observation is a `final` for its item; the provider's own
 * `agent_response_correction` restatement of a turn is what the ladder turns
 * into a correction.
 */
export function createElevenLabsEventMapper() {
  const ladder = createVoiceTranscriptLadderMapper();
  const rolesByItemId = new Map<string, 'user' | 'assistant'>();
  let conversationStarted = false;

  const beginConversation = (): void => {
    conversationStarted = true;
    rolesByItemId.clear();
    ladder.beginConversation();
  };

  const map = (value: unknown): VoiceTranscriptCanonicalEvent | null => {
    const record = readRecord(value);
    if (!record || !conversationStarted) return null;
    const observation = readCorrectionObservation(record) ?? readMessageObservation(record);
    if (!observation) return null;
    const { role, text } = observation;
    const itemId = `${ITEM_ID_PREFIX}${observation.providerEventId}`;
    // Provider identity classification, not ladder ordering: a message claiming
    // an item the other speaker already owns is not the same conversation item.
    const knownRole = rolesByItemId.get(itemId);
    if (knownRole !== undefined && knownRole !== role) return null;
    const event = ladder.map({ itemId, eventId: itemId, role, incoming: text, mode: 'final' });
    if (!event) return null;
    rolesByItemId.set(itemId, role);
    // The ladder owns the revision; the leaf only spells the provider's
    // per-observation event identity, which ElevenLabs' wire does not carry
    // because a correction reuses the corrected turn's `event_id`.
    return { ...event, eventId: `${itemId}:${event.revision}` };
  };

  return Object.freeze({ beginConversation, map });
}

export type ElevenLabsEventMapper = ReturnType<typeof createElevenLabsEventMapper>;
