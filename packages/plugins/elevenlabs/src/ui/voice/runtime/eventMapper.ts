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

function readText(record: Readonly<Record<string, unknown>>): string | null {
  const text = typeof record.message === 'string' ? record.message.trim() : '';
  return text || null;
}

function readProviderEventId(record: Readonly<Record<string, unknown>>): string | null {
  const value = record.event_id;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string' || !value || value.trim() !== value) return null;
  return value.length > MAX_PROVIDER_EVENT_ID_LENGTH ? null : value;
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
 * classified observation is a `final` for its item; a restated message with
 * changed text is what the ladder turns into a correction.
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
    const role = readRole(record);
    const text = readText(record);
    if (!role || !text) return null;
    const providerEventId = readProviderEventId(record);
    if (!providerEventId) return null;
    const itemId = `${ITEM_ID_PREFIX}${providerEventId}`;
    // Provider identity classification, not ladder ordering: a message claiming
    // an item the other speaker already owns is not the same conversation item.
    const knownRole = rolesByItemId.get(itemId);
    if (knownRole !== undefined && knownRole !== role) return null;
    const event = ladder.map({ itemId, eventId: itemId, role, incoming: text, mode: 'final' });
    if (!event) return null;
    rolesByItemId.set(itemId, role);
    // The ladder owns the revision; the leaf only spells the provider's
    // per-observation event identity, which ElevenLabs' wire does not carry
    // because it restates the same `event_id` for a corrected message.
    return { ...event, eventId: `${itemId}:${event.revision}` };
  };

  return Object.freeze({ beginConversation, map });
}

export type ElevenLabsEventMapper = ReturnType<typeof createElevenLabsEventMapper>;
