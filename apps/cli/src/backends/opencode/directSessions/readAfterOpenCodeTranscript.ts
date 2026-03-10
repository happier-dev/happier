import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { createOpenCodeDirectClient } from './createOpenCodeDirectClient';
import { decodeOpenCodeDirectAfterCursor, encodeOpenCodeDirectAfterCursor } from './openCodeDirectAfterCursor';
import { mapOpenCodeMessageToDirectItem } from './mapOpenCodeMessageToDirectItem';

export async function readAfterOpenCodeTranscript(params: Readonly<{
  source: DirectSessionsSource;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{ items: DirectTranscriptRawMessageV1[]; nextCursor: string | null; truncated: boolean }>> {
  const client = await createOpenCodeDirectClient(params.source);

  try {
    const rawMessages = await client.sessionMessagesList({ sessionId: params.remoteSessionId });
    const maxItems = Math.max(1, Math.trunc(params.maxItems));

    if (params.cursor === 'tail') {
      return {
        items: [],
        nextCursor: encodeOpenCodeDirectAfterCursor({ v: 1, kind: 'opencodeAfter', nextIndex: rawMessages.length }),
        truncated: false,
      };
    }

    const decoded = decodeOpenCodeDirectAfterCursor(params.cursor);
    if (!decoded) {
      return { items: [], nextCursor: null, truncated: true };
    }

    if (decoded.nextIndex > rawMessages.length) {
      return {
        items: [],
        nextCursor: encodeOpenCodeDirectAfterCursor({ v: 1, kind: 'opencodeAfter', nextIndex: rawMessages.length }),
        truncated: true,
      };
    }

    const slice = rawMessages.slice(decoded.nextIndex);
    const items: DirectTranscriptRawMessageV1[] = [];
    for (let i = 0; i < slice.length && items.length < maxItems; i++) {
      const msg = mapOpenCodeMessageToDirectItem(slice[i], decoded.nextIndex + i);
      if (!msg) continue;
      items.push(msg);
    }

    return {
      items,
      nextCursor: encodeOpenCodeDirectAfterCursor({ v: 1, kind: 'opencodeAfter', nextIndex: rawMessages.length }),
      truncated: false,
    };
  } finally {
    await client.dispose().catch(() => {});
  }
}
