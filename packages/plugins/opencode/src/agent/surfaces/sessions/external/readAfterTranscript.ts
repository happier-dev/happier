import type {
  ExternalSessionsSource,
  ExternalSessionTranscriptRawMessageV1,
} from '@happier-dev/plugin-sdk/sessions';

import {
  decodeOpenCodeIndexCursor,
  encodeOpenCodeIndexCursor,
  readOpenCodeTranscriptForwardWindow,
} from '../../../runtime/server/transcript/indexedTranscript.js';
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
  return encodeOpenCodeIndexCursor(value);
}

export function decodeOpenCodeExternalAfterCursor(raw: string): OpenCodeAfterCursorV1 | null {
  const decoded = decodeOpenCodeIndexCursor(raw, 'opencodeAfter');
  return decoded?.kind === 'opencodeAfter' ? decoded : null;
}

export async function readAfterOpenCodeTranscript(params: Readonly<{
  source: ExternalSessionsSource;
  providerSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{
  items: readonly ExternalSessionTranscriptRawMessageV1[];
  nextCursor: string | null;
  truncated: boolean;
}>> {
  const client = await createOpenCodeExternalSessionClient({ source: params.source });
  try {
    const rawMessages = await client.sessionMessagesList({ sessionId: params.providerSessionId });

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

    const page = readOpenCodeTranscriptForwardWindow<ExternalSessionTranscriptRawMessageV1>({
      messages: rawMessages,
      startIndex: decoded.nextIndex,
      maxBytes: params.maxBytes,
      maxItems: params.maxItems,
      mapMessage: (message) => mapOpenCodeMessageToExternalSessionItem(message, params.providerSessionId),
      measureItemBytes: measureOpenCodeExternalTranscriptItemBytes,
    });
    return {
      items: page.items,
      nextCursor: encodeOpenCodeExternalAfterCursor({ v: 1, kind: 'opencodeAfter', nextIndex: page.nextIndex }),
      truncated: page.truncated,
    };
  } finally {
    await client.dispose().catch(() => {});
  }
}
