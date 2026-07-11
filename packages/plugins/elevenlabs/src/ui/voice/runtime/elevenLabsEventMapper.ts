import type { VoiceTranscriptCanonicalEventV1 } from '@happier-dev/protocol';

type ItemState = Readonly<{
  role: 'user' | 'assistant';
  revision: number;
  text: string;
}>;

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
  return value;
}

export function createElevenLabsEventMapper() {
  let epoch = 0;
  let sequence = 0;
  let syntheticItemSequence = 0;
  const items = new Map<string, ItemState>();

  const beginConversation = (): void => {
    epoch += 1;
    sequence = 0;
    syntheticItemSequence = 0;
    items.clear();
  };

  const map = (value: unknown): VoiceTranscriptCanonicalEventV1 | null => {
    const record = readRecord(value);
    if (!record || epoch === 0) return null;
    const role = readRole(record);
    const text = readText(record);
    if (!role || !text) return null;
    const providerEventId = readProviderEventId(record);
    const itemId = providerEventId
      ? `elevenlabs:message:${providerEventId}`
      : `elevenlabs:message:synthetic-${++syntheticItemSequence}`;
    const previous = items.get(itemId);
    if (previous?.role !== undefined && previous.role !== role) return null;
    if (previous?.text === text) return null;
    const revision = (previous?.revision ?? 0) + 1;
    const nextSequence = ++sequence;
    items.set(itemId, { role, revision, text });
    return {
      v: 1,
      type: previous ? 'voice.transcript.corrected' : 'voice.transcript.final',
      epoch,
      sequence: nextSequence,
      revision,
      eventId: `${itemId}:${revision}`,
      itemId,
      role,
      text,
      provenance: 'live',
    };
  };

  return Object.freeze({ beginConversation, map });
}

export type ElevenLabsEventMapper = ReturnType<typeof createElevenLabsEventMapper>;
