import type {
  ExternalSessionsSource,
  ExternalSessionTranscriptRawMessageV1,
} from '@happier-dev/protocol';

import { createOpenCodeExternalSessionClient } from './client.js';
import {
  mapOpenCodeMessageToExternalSessionItem,
  measureOpenCodeExternalTranscriptItemBytes,
} from './messages.js';
import { encodeOpenCodeExternalAfterCursor } from './readAfterTranscript.js';

type OpenCodeBackwardCursorV1 = Readonly<{
  v: 1;
  kind: 'opencodeBackward';
  endIndex: number;
}>;

function encodeBackwardCursor(value: OpenCodeBackwardCursorV1): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeBackwardCursor(raw: string | undefined): OpenCodeBackwardCursorV1 | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1 || record.kind !== 'opencodeBackward') return null;
    const endIndex = typeof record.endIndex === 'number' && Number.isFinite(record.endIndex)
      ? Math.trunc(record.endIndex)
      : NaN;
    return Number.isFinite(endIndex) && endIndex >= 0
      ? { v: 1, kind: 'opencodeBackward', endIndex }
      : null;
  } catch {
    return null;
  }
}

export async function pageOpenCodeTranscript(params: Readonly<{
  source: ExternalSessionsSource;
  providerSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{
  items: ExternalSessionTranscriptRawMessageV1[];
  nextCursor: string | null;
  tailCursor: string | null;
  hasMore: boolean;
  truncated?: boolean;
}>> {
  if (params.direction !== 'older') {
    return { items: [], nextCursor: null, tailCursor: null, hasMore: false };
  }

  const client = await createOpenCodeExternalSessionClient({ source: params.source });
  try {
    const rawMessages = await client.sessionMessagesList({ sessionId: params.providerSessionId });
    const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
    const maxItems = Math.max(1, Math.trunc(params.maxItems));
    const decoded = decodeBackwardCursor(params.cursor);
    const endIndexRaw = decoded ? decoded.endIndex : rawMessages.length;
    const endIndex = Math.max(0, Math.min(rawMessages.length, endIndexRaw));
    const startIndex = Math.max(0, endIndex - maxItems);
    const tailCursor = encodeOpenCodeExternalAfterCursor({ v: 1, kind: 'opencodeAfter', nextIndex: rawMessages.length });

    const pageMessages = rawMessages.slice(startIndex, endIndex);
    const itemsReversed: ExternalSessionTranscriptRawMessageV1[] = [];
    let firstReturnedIndex: number | null = null;
    let remainingBytes = maxBytes;
    let truncated = false;
    for (let i = pageMessages.length - 1; i >= 0; i -= 1) {
      const item = mapOpenCodeMessageToExternalSessionItem(pageMessages[i], startIndex + i);
      if (!item) continue;
      const itemBytes = measureOpenCodeExternalTranscriptItemBytes(item);
      if (itemBytes > remainingBytes) {
        if (itemsReversed.length === 0) {
          itemsReversed.push(item);
          firstReturnedIndex = startIndex + i;
          remainingBytes = 0;
          continue;
        }
        truncated = true;
        break;
      }
      itemsReversed.push(item);
      firstReturnedIndex = startIndex + i;
      remainingBytes -= itemBytes;
    }

    const items = itemsReversed.reverse();
    const nextEndIndex = firstReturnedIndex ?? startIndex;
    const hasMore = nextEndIndex > 0;
    const nextCursor = hasMore ? encodeBackwardCursor({ v: 1, kind: 'opencodeBackward', endIndex: nextEndIndex }) : null;
    return { items, nextCursor, tailCursor, hasMore, ...(truncated ? { truncated } : {}) };
  } finally {
    await client.dispose().catch(() => {});
  }
}
