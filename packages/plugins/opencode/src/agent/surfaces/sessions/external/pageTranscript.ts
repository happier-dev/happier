import type {
  ExternalSessionsSource,
  ExternalSessionTranscriptRawMessageV1,
} from '@happier-dev/plugin-sdk/sessions';

import {
  decodeOpenCodeIndexCursor,
  encodeOpenCodeIndexCursor,
  readOpenCodeTranscriptBackwardWindow,
} from '../../../runtime/server/transcript/indexedTranscript.js';
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
  return encodeOpenCodeIndexCursor(value);
}

function decodeBackwardCursor(raw: string | undefined): OpenCodeBackwardCursorV1 | null {
  const decoded = decodeOpenCodeIndexCursor(raw, 'opencodeBackward');
  return decoded?.kind === 'opencodeBackward' ? decoded : null;
}

export async function pageOpenCodeTranscript(params: Readonly<{
  source: ExternalSessionsSource;
  providerSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{
  items: readonly ExternalSessionTranscriptRawMessageV1[];
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
    const maxItems = Math.max(1, Math.trunc(params.maxItems));
    const decoded = decodeBackwardCursor(params.cursor);
    const endIndexRaw = decoded ? decoded.endIndex : rawMessages.length;
    const endIndex = Math.max(0, Math.min(rawMessages.length, endIndexRaw));
    const tailCursor = encodeOpenCodeExternalAfterCursor({ v: 1, kind: 'opencodeAfter', nextIndex: rawMessages.length });

    const page = readOpenCodeTranscriptBackwardWindow<ExternalSessionTranscriptRawMessageV1>({
      messages: rawMessages,
      endIndex,
      maxBytes: params.maxBytes,
      maxItems,
      rawItemLimit: maxItems,
      mapMessage: (message) => mapOpenCodeMessageToExternalSessionItem(message, params.providerSessionId),
      measureItemBytes: measureOpenCodeExternalTranscriptItemBytes,
    });
    const nextEndIndex = page.nextIndex;
    const hasMore = nextEndIndex > 0;
    const nextCursor = hasMore ? encodeBackwardCursor({ v: 1, kind: 'opencodeBackward', endIndex: nextEndIndex }) : null;
    return { items: page.items, nextCursor, tailCursor, hasMore, ...(page.truncated ? { truncated: true } : {}) };
  } finally {
    await client.dispose().catch(() => {});
  }
}
