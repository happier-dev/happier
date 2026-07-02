import type {
  ExternalSessionsSource,
  ExternalSessionTranscriptRawMessageV1,
} from '@happier-dev/protocol';

import { createOpenCodeExternalSessionClient } from './client.js';
import {
  mapOpenCodeMessageToExternalSessionItem,
  measureOpenCodeExternalTranscriptItemBytes,
} from './messages.js';

export type OpenCodeAfterCursorV1 = Readonly<{
  v: 1;
  kind: 'opencodeAfter';
  nextIndex: number;
}>;

export function encodeOpenCodeExternalAfterCursor(value: OpenCodeAfterCursorV1): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeOpenCodeExternalAfterCursor(raw: string): OpenCodeAfterCursorV1 | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1 || record.kind !== 'opencodeAfter') return null;
    const nextIndex = typeof record.nextIndex === 'number' && Number.isFinite(record.nextIndex)
      ? Math.trunc(record.nextIndex)
      : NaN;
    return Number.isFinite(nextIndex) && nextIndex >= 0
      ? { v: 1, kind: 'opencodeAfter', nextIndex }
      : null;
  } catch {
    return null;
  }
}

export async function readAfterOpenCodeTranscript(params: Readonly<{
  source: ExternalSessionsSource;
  providerSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{ items: ExternalSessionTranscriptRawMessageV1[]; nextCursor: string | null; truncated: boolean }>> {
  const client = await createOpenCodeExternalSessionClient({ source: params.source });
  try {
    const rawMessages = await client.sessionMessagesList({ sessionId: params.providerSessionId });
    const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
    const maxItems = Math.max(1, Math.trunc(params.maxItems));

    if (params.cursor === 'tail') {
      return {
        items: [],
        nextCursor: encodeOpenCodeExternalAfterCursor({ v: 1, kind: 'opencodeAfter', nextIndex: rawMessages.length }),
        truncated: false,
      };
    }

    const decoded = decodeOpenCodeExternalAfterCursor(params.cursor);
    if (!decoded) {
      return { items: [], nextCursor: null, truncated: true };
    }

    if (decoded.nextIndex > rawMessages.length) {
      return {
        items: [],
        nextCursor: encodeOpenCodeExternalAfterCursor({ v: 1, kind: 'opencodeAfter', nextIndex: rawMessages.length }),
        truncated: true,
      };
    }

    const slice = rawMessages.slice(decoded.nextIndex);
    const items: ExternalSessionTranscriptRawMessageV1[] = [];
    let remainingBytes = maxBytes;
    let consumedCount = 0;
    let truncated = false;

    for (let i = 0; i < slice.length; i += 1) {
      const item = mapOpenCodeMessageToExternalSessionItem(slice[i], decoded.nextIndex + i);
      consumedCount += 1;
      if (!item) continue;
      const itemBytes = measureOpenCodeExternalTranscriptItemBytes(item);
      if (items.length >= maxItems) {
        consumedCount -= 1;
        truncated = true;
        break;
      }
      if (itemBytes > remainingBytes) {
        if (items.length === 0) {
          items.push(item);
          remainingBytes = 0;
          continue;
        }
        consumedCount -= 1;
        truncated = true;
        break;
      }
      items.push(item);
      remainingBytes -= itemBytes;
    }

    const nextIndex = decoded.nextIndex + consumedCount;
    return {
      items,
      nextCursor: encodeOpenCodeExternalAfterCursor({ v: 1, kind: 'opencodeAfter', nextIndex }),
      truncated: truncated || nextIndex < rawMessages.length,
    };
  } finally {
    await client.dispose().catch(() => {});
  }
}
