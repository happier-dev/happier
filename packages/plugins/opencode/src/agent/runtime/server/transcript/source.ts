import type {
  TranscriptSourceDefinitionV1,
  TranscriptSourcePageV1,
  TranscriptSourceReadAfterV1,
} from '@happier-dev/plugin-sdk';
import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/plugin-sdk/sessions';

import type { OpenCodeServerClient } from '../openCodeServerClient.js';
import {
  createOpenCodeTranscriptProjectionMapper,
  decodeOpenCodeIndexCursor,
  encodeOpenCodeIndexCursor,
  measureOpenCodeTranscriptItemBytes,
  readOpenCodeTranscriptBackwardWindow,
  readOpenCodeTranscriptForwardWindow,
} from './indexedTranscript.js';

const EMPTY_PAGE: TranscriptSourcePageV1<ExternalSessionTranscriptRawMessageV1> = {
  items: [],
  nextCursor: null,
  tailCursor: null,
  hasMore: false,
  truncated: false,
};

const INVALID_CURSOR_PAGE: TranscriptSourcePageV1<ExternalSessionTranscriptRawMessageV1> = {
  ...EMPTY_PAGE,
  truncated: true,
};

type OpenCodeProviderMessages = Readonly<{
  providerSessionId: string;
  messages: readonly unknown[];
}>;

export function createOpenCodeTranscriptSourceDefinition(params: Readonly<{
  id: string;
  client: OpenCodeServerClient;
  readProviderSessionId: () => string | null;
  isHappierAuthoredProviderUserMessageId?: (messageId: string) => boolean;
}>): TranscriptSourceDefinitionV1<ExternalSessionTranscriptRawMessageV1> {
  const readProviderMessages = async (): Promise<OpenCodeProviderMessages | null> => {
    const providerSessionId = params.readProviderSessionId();
    if (!providerSessionId) return null;
    return {
      providerSessionId,
      messages: await params.client.sessionMessages({ sessionId: providerSessionId }),
    };
  };

  return {
    id: params.id,
    page: async ({ direction, cursor, maxBytes, maxItems }) => {
      if (direction !== 'older') return EMPTY_PAGE;
      const decoded = cursor ? decodeOpenCodeIndexCursor(cursor, 'opencodeTranscript') : null;
      if (cursor && !decoded) return INVALID_CURSOR_PAGE;
      const providerMessages = await readProviderMessages();
      if (!providerMessages) return EMPTY_PAGE;
      const { messages, providerSessionId } = providerMessages;
      const endIndex = Math.min(decoded?.kind === 'opencodeTranscript' ? decoded.nextIndex : messages.length, messages.length);
      const mapMessage = createOpenCodeTranscriptProjectionMapper({
        messages,
        providerSessionId,
        options: {
          isHappierAuthoredProviderUserMessageId: params.isHappierAuthoredProviderUserMessageId,
        },
      });
      const page = readOpenCodeTranscriptBackwardWindow({
        messages,
        endIndex,
        maxBytes,
        maxItems,
        mapMessage,
        measureItemBytes: measureOpenCodeTranscriptItemBytes,
      });
      const nextCursor = page.nextIndex > 0
        ? encodeOpenCodeIndexCursor({ v: 1, kind: 'opencodeTranscript', nextIndex: page.nextIndex })
        : null;
      return {
        items: page.items,
        nextCursor,
        tailCursor: encodeOpenCodeIndexCursor({ v: 1, kind: 'opencodeTranscript', nextIndex: messages.length }),
        hasMore: nextCursor !== null,
        truncated: page.truncated || (decoded?.kind === 'opencodeTranscript' ? decoded.nextIndex : messages.length) > messages.length,
      };
    },
    readAfter: async ({ cursor, maxBytes, maxItems }): Promise<TranscriptSourceReadAfterV1<ExternalSessionTranscriptRawMessageV1>> => {
      if (cursor === 'tail') {
        const providerMessages = await readProviderMessages();
        if (!providerMessages) return { items: [], nextCursor: null, truncated: false };
        return {
          items: [],
          nextCursor: encodeOpenCodeIndexCursor({ v: 1, kind: 'opencodeTranscript', nextIndex: providerMessages.messages.length }),
          truncated: false,
        };
      }
      const decoded = decodeOpenCodeIndexCursor(cursor, 'opencodeTranscript');
      if (!decoded) return { items: [], nextCursor: null, truncated: true };
      const providerMessages = await readProviderMessages();
      if (!providerMessages) return { items: [], nextCursor: null, truncated: false };
      const { messages, providerSessionId } = providerMessages;
      const decodedNextIndex = decoded.kind === 'opencodeTranscript' ? decoded.nextIndex : 0;
      const startIndex = Math.min(decodedNextIndex, messages.length);
      const mapMessage = createOpenCodeTranscriptProjectionMapper({
        messages,
        providerSessionId,
        options: {
          isHappierAuthoredProviderUserMessageId: params.isHappierAuthoredProviderUserMessageId,
        },
      });
      const page = readOpenCodeTranscriptForwardWindow({
        messages,
        startIndex,
        maxBytes,
        maxItems,
        mapMessage,
        measureItemBytes: measureOpenCodeTranscriptItemBytes,
      });
      return {
        items: page.items,
        nextCursor: encodeOpenCodeIndexCursor({ v: 1, kind: 'opencodeTranscript', nextIndex: page.nextIndex }),
        truncated: page.truncated || decodedNextIndex > messages.length,
      };
    },
    acquireFollowLease: async () => null,
  };
}
