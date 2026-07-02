import type {
  TranscriptSourceDefinitionV1,
  TranscriptSourcePageV1,
  TranscriptSourceReadAfterV1,
} from '@happier-dev/plugin-sdk';
import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';

import type { OpenCodeServerClient } from '../openCodeServerClient.js';
import {
  classifyOpenCodeMessageForProjection,
  extractOpenCodeProjectedText,
} from './projection/index.js';

type OpenCodeTranscriptCursorV1 = Readonly<{
  v: 1;
  kind: 'opencodeTranscript';
  nextIndex: number;
}>;

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

function encodeCursor(value: OpenCodeTranscriptCursorV1): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): OpenCodeTranscriptCursorV1 | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const nextIndex = typeof record.nextIndex === 'number' && Number.isFinite(record.nextIndex)
      ? Math.trunc(record.nextIndex)
      : NaN;
    if (record.v !== 1 || record.kind !== 'opencodeTranscript' || !Number.isFinite(nextIndex) || nextIndex < 0) {
      return null;
    }
    return { v: 1, kind: 'opencodeTranscript', nextIndex };
  } catch {
    return null;
  }
}

function measureItemBytes(item: ExternalSessionTranscriptRawMessageV1): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

function mapMessageToTranscriptItem(
  message: unknown,
  index: number,
): ExternalSessionTranscriptRawMessageV1 | null {
  const fallbackId = `opencode:${Math.max(0, Math.trunc(index))}`;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return {
      id: fallbackId,
      localId: fallbackId,
      createdAtMs: 0,
      raw: {
        role: 'agent',
        content: {
          type: 'output',
          data: {
            type: 'opaque',
            reason: 'invalid_message',
            original: message,
          },
        },
      },
    };
  }

  const record = message as Record<string, unknown>;
  const projection = classifyOpenCodeMessageForProjection(record);
  if (projection.kind !== 'user_transcript' && projection.kind !== 'assistant_transcript') return null;

  const contentText = typeof record.content === 'string' ? record.content.trim() : '';
  const text = contentText || extractOpenCodeProjectedText(
    Array.isArray(record.parts) ? record.parts : [],
    { context: 'direct_transcript' },
  );
  if (!text) return null;

  const stableId = projection.messageId || fallbackId;
  if (projection.kind === 'user_transcript') {
    return {
      id: stableId,
      localId: stableId,
      createdAtMs: projection.createdAtMs,
      raw: {
        role: 'user',
        content: { type: 'text', text },
      },
    };
  }

  return {
    id: stableId,
    localId: stableId,
    createdAtMs: projection.createdAtMs,
    raw: {
      role: 'agent',
      content: {
        type: 'acp',
        provider: 'opencode',
        data: { type: 'message', message: text },
      },
    },
  };
}

function readWindow(params: Readonly<{
  messages: readonly unknown[];
  startIndex: number;
  maxItems: number;
  maxBytes: number;
}>): Readonly<{
  items: readonly ExternalSessionTranscriptRawMessageV1[];
  nextIndex: number;
  truncated: boolean;
}> {
  const items: ExternalSessionTranscriptRawMessageV1[] = [];
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  let remainingBytes = Math.max(1, Math.trunc(params.maxBytes));
  let nextIndex = Math.max(0, Math.trunc(params.startIndex));
  let truncated = false;

  for (let i = nextIndex; i < params.messages.length; i += 1) {
    const item = mapMessageToTranscriptItem(params.messages[i], i);
    nextIndex = i + 1;
    if (!item) continue;
    const itemBytes = measureItemBytes(item);
    if (items.length >= maxItems) {
      nextIndex = i;
      truncated = true;
      break;
    }
    if (itemBytes > remainingBytes && items.length === 0) {
      items.push(item);
      truncated = true;
      break;
    }
    if (itemBytes > remainingBytes && items.length > 0) {
      nextIndex = i;
      truncated = true;
      break;
    }
    items.push(item);
    remainingBytes = Math.max(0, remainingBytes - itemBytes);
  }

  return {
    items,
    nextIndex,
    truncated: truncated || nextIndex < params.messages.length,
  };
}

function readOlderWindow(params: Readonly<{
  messages: readonly unknown[];
  endIndex: number;
  maxItems: number;
  maxBytes: number;
}>): Readonly<{
  items: readonly ExternalSessionTranscriptRawMessageV1[];
  nextIndex: number;
  truncated: boolean;
}> {
  const reversedItems: ExternalSessionTranscriptRawMessageV1[] = [];
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  let remainingBytes = Math.max(1, Math.trunc(params.maxBytes));
  let nextIndex = Math.min(params.messages.length, Math.max(0, Math.trunc(params.endIndex)));
  let truncated = false;

  for (let i = nextIndex - 1; i >= 0; i -= 1) {
    const item = mapMessageToTranscriptItem(params.messages[i], i);
    nextIndex = i;
    if (!item) continue;
    const itemBytes = measureItemBytes(item);
    if (reversedItems.length >= maxItems) {
      nextIndex = i + 1;
      truncated = true;
      break;
    }
    if (itemBytes > remainingBytes && reversedItems.length === 0) {
      reversedItems.push(item);
      truncated = true;
      break;
    }
    if (itemBytes > remainingBytes && reversedItems.length > 0) {
      nextIndex = i + 1;
      truncated = true;
      break;
    }
    reversedItems.push(item);
    remainingBytes = Math.max(0, remainingBytes - itemBytes);
  }

  return {
    items: reversedItems.reverse(),
    nextIndex,
    truncated,
  };
}

export function createOpenCodeTranscriptSourceDefinition(params: Readonly<{
  id: string;
  client: OpenCodeServerClient;
  readProviderSessionId: () => string | null;
}>): TranscriptSourceDefinitionV1<ExternalSessionTranscriptRawMessageV1> {
  const readMessages = async (): Promise<readonly unknown[] | null> => {
    const providerSessionId = params.readProviderSessionId();
    if (!providerSessionId) return null;
    return await params.client.sessionMessages({ sessionId: providerSessionId });
  };

  return {
    id: params.id,
    page: async ({ direction, cursor, maxBytes, maxItems }) => {
      if (direction !== 'older') return EMPTY_PAGE;
      const decoded = cursor ? decodeCursor(cursor) : null;
      if (cursor && !decoded) return INVALID_CURSOR_PAGE;
      const messages = await readMessages();
      if (!messages) return EMPTY_PAGE;
      const endIndex = Math.min(decoded?.nextIndex ?? messages.length, messages.length);
      const page = readOlderWindow({ messages, endIndex, maxBytes, maxItems });
      const nextCursor = page.nextIndex > 0
        ? encodeCursor({ v: 1, kind: 'opencodeTranscript', nextIndex: page.nextIndex })
        : null;
      return {
        items: page.items,
        nextCursor,
        tailCursor: encodeCursor({ v: 1, kind: 'opencodeTranscript', nextIndex: messages.length }),
        hasMore: nextCursor !== null,
        truncated: page.truncated || (decoded?.nextIndex ?? messages.length) > messages.length,
      };
    },
    readAfter: async ({ cursor, maxBytes, maxItems }): Promise<TranscriptSourceReadAfterV1<ExternalSessionTranscriptRawMessageV1>> => {
      if (cursor === 'tail') {
        const messages = await readMessages();
        if (!messages) return { items: [], nextCursor: null, truncated: false };
        return {
          items: [],
          nextCursor: encodeCursor({ v: 1, kind: 'opencodeTranscript', nextIndex: messages.length }),
          truncated: false,
        };
      }
      const decoded = decodeCursor(cursor);
      if (!decoded) return { items: [], nextCursor: null, truncated: true };
      const messages = await readMessages();
      if (!messages) return { items: [], nextCursor: null, truncated: false };
      const startIndex = Math.min(decoded.nextIndex, messages.length);
      const page = readWindow({ messages, startIndex, maxBytes, maxItems });
      return {
        items: page.items,
        nextCursor: encodeCursor({ v: 1, kind: 'opencodeTranscript', nextIndex: page.nextIndex }),
        truncated: page.truncated || decoded.nextIndex > messages.length,
      };
    },
    acquireFollowLease: async () => null,
  };
}
