import type { CapturedEvent } from '../socketClient';

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

  for (const needle of required) {
    if (!needle) return false;
    const okFromMessages = params.decodedMessages.some((msg) => payloadContainsSubstring(asRecord(msg) ?? msg, needle));
    if (okFromMessages) continue;

    const okFromSocket =
      (params.socketEvents ?? []).some((event) => payloadContainsSubstring(asRecord(event) ?? event, needle));
    const ok = okFromMessages || okFromSocket;
    if (!ok) return false;
  }

  return true;
}
