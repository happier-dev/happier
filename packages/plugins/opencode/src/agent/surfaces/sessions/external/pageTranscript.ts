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
  /** The vendor continuation this page resumes from; null resumes at the newest message. */
  before: string | null;
  sessionCreatedAtMs: number;
  /**
   * When the previous page stopped inside one native message, its id plus the
   * number of its newest semantic items already served. The next page re-reads
   * that exact message at its own scope anchor and serves the older remainder.
   * One OpenCode message can expand to more semantic items than a page allows,
   * so this source-bound subitem identity keeps backward paging lossless.
   */
  messageId?: string;
  subIndex?: number;
}>;

function encodeOpenCodeTranscriptPageCursor(value: OpenCodeTranscriptPageCursorV1): string {
  return Buffer.from(JSON.stringify({
    v: value.v,
    kind: value.kind,
    before: value.before,
    sessionCreatedAtMs: value.sessionCreatedAtMs,
    ...(value.messageId !== undefined && value.subIndex !== undefined
      ? { messageId: value.messageId, subIndex: value.subIndex }
      : {}),
  }), 'utf8').toString('base64url');
}

function decodeOpenCodeTranscriptPageCursor(raw: string): OpenCodeTranscriptPageCursorV1 | null {
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    const before = Reflect.get(decoded, 'before');
    const sessionCreatedAtMs = Reflect.get(decoded, 'sessionCreatedAtMs');
    const rawMessageId = Reflect.get(decoded, 'messageId');
    const rawSubIndex = Reflect.get(decoded, 'subIndex');
    const intraMessage = rawMessageId !== undefined || rawSubIndex !== undefined;
    if (
      (intraMessage && (typeof rawMessageId !== 'string' || rawMessageId.length === 0))
      || (intraMessage
        && (typeof rawSubIndex !== 'number' || !Number.isSafeInteger(rawSubIndex) || rawSubIndex < 1))
    ) {
      return null;
    }
    return Reflect.get(decoded, 'v') === 1
      && Reflect.get(decoded, 'kind') === 'opencodeTranscriptPage'
      && (before === null || (typeof before === 'string' && before.length > 0))
      && typeof sessionCreatedAtMs === 'number'
      && Number.isSafeInteger(sessionCreatedAtMs)
      && sessionCreatedAtMs >= 0
      ? {
        v: 1,
        kind: 'opencodeTranscriptPage',
        before,
        sessionCreatedAtMs,
        ...(intraMessage ? { messageId: rawMessageId as string, subIndex: rawSubIndex as number } : {}),
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
    const resumeMessageId = decodedCursor?.messageId ?? null;
    const resumeSubIndex = decodedCursor?.subIndex ?? 0;
    // A mid-message resume re-reads the exact boundary message at this page's
    // own scope anchor. A boundary that no longer returns that message is a
    // moved source, not a page: fail closed instead of guessing positions.
    const intraMessageResume = resumeMessageId !== null && resumeSubIndex > 0;
    let pageResult = await client.sessionMessagesList({
      sessionId: params.providerSessionId,
      limit: intraMessageResume ? 1 : maxItems,
      ...(decodedCursor?.before ? { before: decodedCursor.before } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    let rawMessages = pageResult.items;
    if (intraMessageResume
      && (rawMessages.length !== 1 || readOpenCodeMessageId(rawMessages[0]) !== resumeMessageId)
    ) {
      return sourceChangedPage();
    }
    const newestMessageId = params.cursor ? null : readOpenCodeMessageId(rawMessages.at(-1));

    let encounteredUnsupportedRecord = false;
    const readPage = (
      messages: readonly unknown[],
      rawItemLimit: number,
      startSubIndex = 0,
    ) => readOpenCodeTranscriptBackwardWindow<AgentExternalSessionTranscriptItem>({
      messages,
      endIndex: messages.length,
      maxBytes: params.maxBytes,
      maxItems,
      rawItemLimit,
      ...(startSubIndex > 0 ? { startSubIndex } : {}),
      mapMessage: (message) => {
        const projection = projectOpenCodeExternalSessionMessage(message, params.providerSessionId);
        if (projection.disposition === 'unsupported') encounteredUnsupportedRecord = true;
        return projection.items;
      },
      measureItemBytes: measureOpenCodeTranscriptItemBytes,
    });
    let page = readPage(rawMessages, intraMessageResume ? 1 : maxItems, resumeSubIndex);
    // A multi-message page whose window stopped early is re-scoped to exactly
    // one aligned message, so the vendor continuation matches what was served.
    // A single-message page (including intra-message resumes) is already
    // aligned; its own vendor continuation addresses this exact message.
    if (page.nextIndex > 0 && rawMessages.length > 1) {
      pageResult = await client.sessionMessagesList({
        sessionId: params.providerSessionId,
        limit: 1,
        ...(decodedCursor?.before ? { before: decodedCursor.before } : {}),
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
    // When the window stopped inside the boundary message, the continuation
    // anchors there instead of advancing the vendor cursor past unserved items.
    const boundaryMessageId = page.nextSubIndex > 0
      ? readOpenCodeMessageId(rawMessages.at(page.nextIndex - 1))
      : null;
    const nextCursor = boundaryMessageId !== null
      ? encodeOpenCodeTranscriptPageCursor({
        v: 1,
        kind: 'opencodeTranscriptPage',
        before: decodedCursor?.before ?? null,
        sessionCreatedAtMs,
        messageId: boundaryMessageId,
        subIndex: page.nextSubIndex,
      })
      : pageResult.nextCursor === null
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
