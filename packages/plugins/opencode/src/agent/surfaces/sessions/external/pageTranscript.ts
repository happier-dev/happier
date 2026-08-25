import type {
  AgentExternalSessionTranscriptItem,
  AgentExternalSessionsManagedEndpointRead,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
  measureOpenCodeTranscriptItemBytes,
  readOpenCodeTranscriptBackwardWindow,
} from '../../../runtime/server/transcript/indexedTranscript.js';
import {
  createOpenCodeExternalSessionClient,
  type OpenCodeExternalSessionSource,
} from './client.js';
import {
  projectOpenCodeExternalSessionMessage,
} from './messages.js';
import {
  encodeOpenCodeExternalAfterCursor,
  readOpenCodeSessionCreatedAtMs,
} from './readAfterTranscript.js';

type OpenCodeTranscriptPageCursorV1 = Readonly<{
  v: 1;
  kind: 'opencodeTranscriptPage';
  before: string;
  sessionCreatedAtMs: number;
}>;

function encodeOpenCodeTranscriptPageCursor(value: OpenCodeTranscriptPageCursorV1): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeOpenCodeTranscriptPageCursor(raw: string): OpenCodeTranscriptPageCursorV1 | null {
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    const before = Reflect.get(decoded, 'before');
    const sessionCreatedAtMs = Reflect.get(decoded, 'sessionCreatedAtMs');
    return Reflect.get(decoded, 'v') === 1
      && Reflect.get(decoded, 'kind') === 'opencodeTranscriptPage'
      && typeof before === 'string'
      && before.length > 0
      && typeof sessionCreatedAtMs === 'number'
      && Number.isSafeInteger(sessionCreatedAtMs)
      && sessionCreatedAtMs >= 0
      ? {
          v: 1,
          kind: 'opencodeTranscriptPage',
          before,
          sessionCreatedAtMs,
        }
      : null;
  } catch {
    return null;
  }
}

function sourceChangedPage() {
  return {
    items: [],
    nextCursor: null,
    tailCursor: null,
    hasMore: false,
    truncated: true,
  } as const;
}

function readOpenCodeMessageId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const info = Reflect.get(raw, 'info');
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  const id = Reflect.get(info, 'id');
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export async function pageOpenCodeTranscript(params: Readonly<{
  source: OpenCodeExternalSessionSource;
  providerSessionId: string;
  direction: 'older';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
  managedEndpointRead?: AgentExternalSessionsManagedEndpointRead;
}>): Promise<Readonly<{
  items: readonly AgentExternalSessionTranscriptItem[];
  nextCursor: string | null;
  tailCursor: string | null;
  hasMore: boolean;
  truncated?: boolean;
}>> {
  const client = await createOpenCodeExternalSessionClient({
    source: params.source,
    maxResponseBytes: params.maxBytes,
    ...(params.env ? { env: params.env } : {}),
    ...(params.managedEndpointRead ? { managedEndpointRead: params.managedEndpointRead } : {}),
  });
  try {
    const maxItems = Math.max(1, Math.trunc(params.maxItems));
    const decodedCursor = params.cursor
      ? decodeOpenCodeTranscriptPageCursor(params.cursor)
      : null;
    if (params.cursor && !decodedCursor) return sourceChangedPage();
    const expectedSessionCreatedAtMs = decodedCursor?.sessionCreatedAtMs ?? null;
    const sessionCreatedAtMs = readOpenCodeSessionCreatedAtMs(
      await client.sessionGet({
        sessionId: params.providerSessionId,
        ...(params.signal ? { signal: params.signal } : {}),
      }),
      params.providerSessionId,
    );
    if (
      sessionCreatedAtMs === null
      || (
        expectedSessionCreatedAtMs !== null
        && sessionCreatedAtMs !== expectedSessionCreatedAtMs
      )
    ) {
      return sourceChangedPage();
    }
    let pageResult = await client.sessionMessagesList({
      sessionId: params.providerSessionId,
      limit: maxItems,
      ...(decodedCursor ? { before: decodedCursor.before } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    let rawMessages = pageResult.items;
    const newestMessageId = params.cursor ? null : readOpenCodeMessageId(rawMessages.at(-1));

    let encounteredUnsupportedRecord = false;
    const readPage = (messages: readonly unknown[], rawItemLimit: number) => readOpenCodeTranscriptBackwardWindow<AgentExternalSessionTranscriptItem>({
      messages,
      endIndex: messages.length,
      maxBytes: params.maxBytes,
      maxItems,
      rawItemLimit,
      mapMessage: (message) => {
        const projection = projectOpenCodeExternalSessionMessage(message, params.providerSessionId);
        if (projection.disposition === 'unsupported') encounteredUnsupportedRecord = true;
        return projection.items;
      },
      measureItemBytes: measureOpenCodeTranscriptItemBytes,
    });
    let page = readPage(rawMessages, maxItems);
    if (page.nextIndex > 0) {
      pageResult = await client.sessionMessagesList({
        sessionId: params.providerSessionId,
        limit: 1,
        ...(decodedCursor ? { before: decodedCursor.before } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      rawMessages = pageResult.items;
      encounteredUnsupportedRecord = false;
      page = readPage(rawMessages, 1);
    }
    const confirmedSessionCreatedAtMs = readOpenCodeSessionCreatedAtMs(
      await client.sessionGet({
        sessionId: params.providerSessionId,
        ...(params.signal ? { signal: params.signal } : {}),
      }),
      params.providerSessionId,
    );
    if (confirmedSessionCreatedAtMs !== sessionCreatedAtMs) return sourceChangedPage();
    const tailCursor = decodedCursor === null
      ? encodeOpenCodeExternalAfterCursor({
        v: 3,
        kind: 'opencodeAfter',
        messageId: newestMessageId,
        sessionCreatedAtMs,
      })
      : null;
    const nextCursor = pageResult.nextCursor === null
      ? null
      : encodeOpenCodeTranscriptPageCursor({
          v: 1,
          kind: 'opencodeTranscriptPage',
          before: pageResult.nextCursor,
          sessionCreatedAtMs,
        });
    const hasMore = nextCursor !== null;
    return {
      items: page.items,
      nextCursor,
      tailCursor,
      hasMore,
      ...(page.truncated || encounteredUnsupportedRecord ? { truncated: true } : {}),
    };
  } finally {
    await client.dispose().catch(() => {});
  }
}
