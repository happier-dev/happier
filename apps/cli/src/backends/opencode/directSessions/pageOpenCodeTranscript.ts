import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { createOpenCodeDirectClient } from './createOpenCodeDirectClient';
import { mapOpenCodeMessageToDirectItem } from './mapOpenCodeMessageToDirectItem';
import { encodeOpenCodeDirectAfterCursor } from './openCodeDirectAfterCursor';

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
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as any;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.v !== 1 || parsed.kind !== 'opencodeBackward') return null;
    const endIndex = typeof parsed.endIndex === 'number' && Number.isFinite(parsed.endIndex) ? Math.trunc(parsed.endIndex) : NaN;
    if (!Number.isFinite(endIndex) || endIndex < 0) return null;
    return { v: 1, kind: 'opencodeBackward', endIndex };
  } catch {
    return null;
  }
}

export async function pageOpenCodeTranscript(params: Readonly<{
  source: DirectSessionsSource;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{ items: DirectTranscriptRawMessageV1[]; nextCursor: string | null; tailCursor: string | null; hasMore: boolean; truncated?: boolean }>> {
  if (params.direction !== 'older') {
    return { items: [], nextCursor: null, tailCursor: null, hasMore: false };
  }

  const client = await createOpenCodeDirectClient(params.source);

  try {
    const rawMessages = await client.sessionMessagesList({ sessionId: params.remoteSessionId });
    const maxItems = Math.max(1, Math.trunc(params.maxItems));
    const decoded = decodeBackwardCursor(params.cursor);

    const endIndexRaw = decoded ? decoded.endIndex : rawMessages.length;
    const endIndex = Math.max(0, Math.min(rawMessages.length, endIndexRaw));
    const startIndex = Math.max(0, endIndex - maxItems);
    const tailCursor = encodeOpenCodeDirectAfterCursor({ v: 1, kind: 'opencodeAfter', nextIndex: rawMessages.length });

    const pageMessages = rawMessages.slice(startIndex, endIndex);
    const items: DirectTranscriptRawMessageV1[] = [];
    for (let i = 0; i < pageMessages.length; i++) {
      const msg = mapOpenCodeMessageToDirectItem(pageMessages[i], startIndex + i);
      if (!msg) continue;
      items.push(msg);
    }

    const hasMore = startIndex > 0;
    const nextCursor = hasMore ? encodeBackwardCursor({ v: 1, kind: 'opencodeBackward', endIndex: startIndex }) : null;
    return { items, nextCursor, tailCursor, hasMore };
  } finally {
    await client.dispose().catch(() => {});
  }
}
