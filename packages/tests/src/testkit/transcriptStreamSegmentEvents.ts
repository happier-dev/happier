import type { CapturedEvent } from './socketClient';

export type TranscriptStreamSegmentContent =
  | { t: 'encrypted'; c: string }
  | { t: 'plain'; v: unknown };

export type TranscriptStreamSegmentMessage = {
  localId: string;
  sidechainId?: string | null;
  content: TranscriptStreamSegmentContent;
  createdAt: number;
  updatedAt: number;
};

export type TranscriptStreamSegmentPayload = {
  type: 'transcript-stream-segment';
  sessionId: string;
  message: TranscriptStreamSegmentMessage;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readContent(value: unknown): TranscriptStreamSegmentContent | null {
  if (!isRecord(value)) return null;
  if (value.t === 'encrypted' && typeof value.c === 'string') {
    return { t: 'encrypted', c: value.c };
  }
  if (value.t === 'plain' && 'v' in value) {
    return { t: 'plain', v: value.v };
  }
  return null;
}

function readTranscriptStreamSegmentPayload(value: unknown): TranscriptStreamSegmentPayload | null {
  if (!isRecord(value)) return null;
  if (value.type !== 'transcript-stream-segment') return null;
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) return null;
  if (!isRecord(value.message)) return null;

  const localId = value.message.localId;
  const createdAt = value.message.createdAt;
  const updatedAt = value.message.updatedAt;
  const content = readContent(value.message.content);
  if (typeof localId !== 'string' || localId.length === 0) return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
  if (!content) return null;

  const sidechainId = value.message.sidechainId;
  return {
    type: 'transcript-stream-segment',
    sessionId: value.sessionId,
    message: {
      localId,
      ...(sidechainId === null || typeof sidechainId === 'string' ? { sidechainId } : {}),
      content,
      createdAt,
      updatedAt,
    },
  };
}

export function createEncryptedTranscriptStreamSegmentMessage(params: {
  localId: string;
  ciphertextBase64: string;
  nowMs?: number;
}): TranscriptStreamSegmentMessage {
  const nowMs = params.nowMs ?? Date.now();
  return {
    localId: params.localId,
    content: { t: 'encrypted', c: params.ciphertextBase64 },
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

export function createPlainTranscriptStreamSegmentMessage(params: {
  localId: string;
  value: unknown;
  nowMs?: number;
}): TranscriptStreamSegmentMessage {
  const nowMs = params.nowMs ?? Date.now();
  return {
    localId: params.localId,
    content: { t: 'plain', v: params.value },
    createdAt: nowMs,
    updatedAt: nowMs,
  };
}

export function findTranscriptStreamSegmentEvent(
  events: CapturedEvent[],
  params: { sessionId: string; localId: string },
): TranscriptStreamSegmentPayload | null {
  for (const event of events) {
    if (event.kind !== 'ephemeral') continue;
    const payload = readTranscriptStreamSegmentPayload(event.payload);
    if (!payload) continue;
    if (payload.sessionId !== params.sessionId) continue;
    if (payload.message.localId !== params.localId) continue;
    return payload;
  }
  return null;
}

export function countTranscriptStreamSegmentEvents(
  events: CapturedEvent[],
  params: { sessionId: string; localId: string },
): number {
  return events.filter((event) => {
    if (event.kind !== 'ephemeral') return false;
    const payload = readTranscriptStreamSegmentPayload(event.payload);
    return payload?.sessionId === params.sessionId && payload.message.localId === params.localId;
  }).length;
}

export function hasRawTranscriptStreamSegmentEvent(
  events: CapturedEvent[],
  params: { sessionId: string; localId: string },
): boolean {
  return events.some((event) => {
    if (event.kind !== 'ephemeral') return false;
    const payload = event.payload;
    if (!isRecord(payload)) return false;
    if (payload.type !== 'transcript-stream-segment') return false;
    if (payload.sessionId !== params.sessionId) return false;
    const message = payload.message;
    return isRecord(message) && message.localId === params.localId;
  });
}
