import type { CapturedEvent } from '../../socketClient';

import { normalizeDecodedTranscriptValue } from '../normalizeDecodedTranscriptValue';
import { payloadContainsSubstring } from './payloadContainsSubstring';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

export function scenarioSatisfiedByMessages(
  params: { decodedMessages: unknown[]; socketEvents?: CapturedEvent[] },
  criteria: { requiredMessageSubstrings?: string[] },
): boolean {
  const required = criteria.requiredMessageSubstrings ?? [];
  if (required.length === 0) return true;

  const assistantLikeMessages = params.decodedMessages.flatMap((msg) => {
    const rec = asRecord(normalizeDecodedTranscriptValue(msg));
    if (!rec) return [];
    const role = typeof rec.role === 'string' ? rec.role : '';
    return role === 'agent' || role === 'assistant' ? [rec] : [];
  });

  const assistantStreamedTextByKey = new Map<string, string>();
  for (const msg of assistantLikeMessages) {
    const meta = asRecord(msg.meta);
    const streamKey = typeof meta?.happierStreamKey === 'string' ? meta.happierStreamKey : '';
    if (!streamKey) continue;

    const content = asRecord(msg.content);
    if (content?.type !== 'acp') continue;
    const data = asRecord(content.data);
    if (data?.type !== 'message') continue;
    const chunk = typeof data.message === 'string' ? data.message : '';
    if (!chunk) continue;

    assistantStreamedTextByKey.set(streamKey, (assistantStreamedTextByKey.get(streamKey) ?? '') + chunk);
  }

  for (const needle of required) {
    if (!needle) return false;
    const okFromMessages = assistantLikeMessages.some((msg) => payloadContainsSubstring(msg, needle));
    if (okFromMessages) continue;

    const okFromStreamedChunks = [...assistantStreamedTextByKey.values()].some((text) => text.includes(needle));
    if (okFromStreamedChunks) continue;

    const okFromSocket =
      (params.socketEvents ?? []).some((event) => payloadContainsSubstring(asRecord(event) ?? event, needle));
    const ok = okFromMessages || okFromSocket;
    if (!ok) return false;
  }

  return true;
}
