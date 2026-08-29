import type {
  AgentExternalSessionTranscriptItem,
  AgentExternalSessionsManagedEndpointRead,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
  measureOpenCodeTranscriptItemBytes,
  readOpenCodeTranscriptForwardWindow,
} from '../../../runtime/server/transcript/indexedTranscript.js';
import {
  createOpenCodeExternalSessionClient,
  type OpenCodeExternalSessionSource,
} from './client.js';
import {
  projectOpenCodeExternalSessionMessage,
} from './messages.js';

export type OpenCodeAfterCursorV3 = Readonly<{
  v: 3;
  kind: 'opencodeAfter';
  messageId: string | null;
  sessionCreatedAtMs: number;
  /**
   * Semantic item position inside `messageId` where the next read resumes.
   * 0 (or absent) is the legacy whole-message anchor: every item of
   * `messageId` and everything before it is consumed. One native OpenCode
   * message can expand to several semantic transcript items, so a bounded
   * page that stopped inside one anchors at this source-bound subitem
   * position instead of losing or repeating the remainder.
   */
  subIndex?: number;
}>;

export function encodeOpenCodeExternalAfterCursor(value: OpenCodeAfterCursorV3): string {
  const subIndex = Math.max(0, Math.trunc(value.subIndex ?? 0));
  return Buffer.from(JSON.stringify({
    v: value.v,
    kind: value.kind,
    messageId: value.messageId,
    sessionCreatedAtMs: value.sessionCreatedAtMs,
    ...(subIndex > 0 ? { subIndex } : {}),
  }), 'utf8').toString('base64url');
}

export function decodeOpenCodeExternalAfterCursor(raw: string): OpenCodeAfterCursorV3 | null {
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    if (Reflect.get(decoded, 'v') !== 3 || Reflect.get(decoded, 'kind') !== 'opencodeAfter') return null;
    const messageId = Reflect.get(decoded, 'messageId');
    const sessionCreatedAtMs = Reflect.get(decoded, 'sessionCreatedAtMs');
    const rawSubIndex = Reflect.get(decoded, 'subIndex');
    const subIndex = rawSubIndex === undefined ? 0 : rawSubIndex;
    return (
      messageId === null || (typeof messageId === 'string' && messageId.length > 0)
    ) && typeof sessionCreatedAtMs === 'number'
      && Number.isSafeInteger(sessionCreatedAtMs)
      && sessionCreatedAtMs >= 0
      && typeof subIndex === 'number'
      && Number.isSafeInteger(subIndex)
      && subIndex >= 0
      ? { v: 3, kind: 'opencodeAfter', messageId, sessionCreatedAtMs, subIndex }
      : null;
  } catch {
    return null;
  }
}

function readOpenCodeMessageId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const info = Reflect.get(raw, 'info');
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  const id = Reflect.get(info, 'id');
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function readOpenCodeSessionCreatedAtMs(
  raw: unknown,
  expectedSessionId: string,
): number | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Reflect.get(raw, 'id') !== expectedSessionId) return null;
  const time = Reflect.get(raw, 'time');
  if (!time || typeof time !== 'object' || Array.isArray(time)) return null;
  const created = Reflect.get(time, 'created');
  return typeof created === 'number' && Number.isSafeInteger(created) && created >= 0
    ? created
    : null;
}

export type OpenCodeExternalReadAfterOutcome =
  | Readonly<{ outcome: 'already_current' }>
  | Readonly<{
      outcome: 'advanced';
      items: readonly AgentExternalSessionTranscriptItem[];
      nextCursor: string;
      boundary: string;
      hasMore: boolean;
      diagnostics?: readonly Readonly<{
        code: string;
        severity: 'benign' | 'required';
        count: number;
        positions: readonly number[];
      }>[];
    }>
  | Readonly<{ outcome: 'gap_or_cursor_expired' }>
  | Readonly<{ outcome: 'source_replaced' }>
  | Readonly<{ outcome: 'source_unavailable' }>
  | Readonly<{ outcome: 'read_failed' }>;

function gap(): OpenCodeExternalReadAfterOutcome {
  return { outcome: 'gap_or_cursor_expired' };
}

export async function readAfterOpenCodeTranscript(params: Readonly<{
  source: OpenCodeExternalSessionSource;
  providerSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
  managedEndpointRead?: AgentExternalSessionsManagedEndpointRead;
}>): Promise<OpenCodeExternalReadAfterOutcome> {
  const client = await createOpenCodeExternalSessionClient({
    source: params.source,
    maxResponseBytes: params.maxBytes,
    ...(params.env ? { env: params.env } : {}),
    ...(params.managedEndpointRead ? { managedEndpointRead: params.managedEndpointRead } : {}),
  });
  try {
    const maxItems = Math.max(1, Math.trunc(params.maxItems));

    if (params.cursor === 'tail') {
      const sessionCreatedAtMs = readOpenCodeSessionCreatedAtMs(
        await client.sessionGet({
          sessionId: params.providerSessionId,
          ...(params.signal ? { signal: params.signal } : {}),
        }),
        params.providerSessionId,
      );
      if (sessionCreatedAtMs === null) return { outcome: 'source_unavailable' };
      const latest = await client.sessionMessagesList({
        sessionId: params.providerSessionId,
        limit: 1,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const confirmedSessionCreatedAtMs = readOpenCodeSessionCreatedAtMs(
        await client.sessionGet({
          sessionId: params.providerSessionId,
          ...(params.signal ? { signal: params.signal } : {}),
        }),
        params.providerSessionId,
      );
      if (confirmedSessionCreatedAtMs !== sessionCreatedAtMs) return { outcome: 'source_replaced' };
      return { outcome: 'already_current' };
    }

    const decoded = decodeOpenCodeExternalAfterCursor(params.cursor);
    if (!decoded) {
      return gap();
    }

    const sessionCreatedAtMs = readOpenCodeSessionCreatedAtMs(
      await client.sessionGet({
        sessionId: params.providerSessionId,
        ...(params.signal ? { signal: params.signal } : {}),
      }),
      params.providerSessionId,
    );
    if (sessionCreatedAtMs === null) return { outcome: 'source_unavailable' };
    if (sessionCreatedAtMs !== decoded.sessionCreatedAtMs) return { outcome: 'source_replaced' };
    const latest = await client.sessionMessagesList({
      sessionId: params.providerSessionId,
      limit: maxItems + 1,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    const confirmedSessionCreatedAtMs = readOpenCodeSessionCreatedAtMs(
      await client.sessionGet({
        sessionId: params.providerSessionId,
        ...(params.signal ? { signal: params.signal } : {}),
      }),
      params.providerSessionId,
    );
    if (confirmedSessionCreatedAtMs !== decoded.sessionCreatedAtMs) return { outcome: 'source_replaced' };
    const rawMessages = latest.items;
    // A subIndex > 0 anchors INSIDE the exact native message: resume at that
    // semantic item; the legacy whole-message anchor resumes after it.
    const resumeSubIndex = Math.max(0, Math.trunc(decoded.subIndex ?? 0));
    const anchorIndex = decoded.messageId === null
      ? -1
      : rawMessages.findIndex((message) => readOpenCodeMessageId(message) === decoded.messageId);
    if (decoded.messageId !== null && anchorIndex === -1) {
      return gap();
    }
    const startIndex = decoded.messageId === null
      ? 0
      : resumeSubIndex > 0
        ? anchorIndex
        : anchorIndex + 1;

    const knownNonTranscriptPositions: number[] = [];
    const unsupportedPositions: number[] = [];
    const page = readOpenCodeTranscriptForwardWindow<AgentExternalSessionTranscriptItem>({
      messages: rawMessages,
      startIndex,
      ...(resumeSubIndex > 0 ? { startSubIndex: resumeSubIndex } : {}),
      maxBytes: params.maxBytes,
      maxItems,
      mapMessage: (message, index) => {
        const projection = projectOpenCodeExternalSessionMessage(message, params.providerSessionId);
        if (projection.disposition === 'known_non_transcript') {
          knownNonTranscriptPositions.push(index);
        } else if (projection.disposition === 'unsupported') {
          unsupportedPositions.push(index);
        }
        return projection.items;
      },
      measureItemBytes: measureOpenCodeTranscriptItemBytes,
    });
    const newestReadMessageId = readOpenCodeMessageId(rawMessages.at(page.nextIndex - 1))
      ?? decoded.messageId;
    // A mid-message stop anchors inside the exact native message that still
    // holds unserved semantic items; whole-message boundaries keep the released
    // anchor shape (subIndex 0 is omitted from the encoded cursor).
    const boundaryMessageId = page.nextSubIndex > 0
      ? readOpenCodeMessageId(rawMessages[page.nextIndex])
      : newestReadMessageId;
    const nextCursor = encodeOpenCodeExternalAfterCursor({
      v: 3,
      kind: 'opencodeAfter',
      messageId: boundaryMessageId,
      sessionCreatedAtMs,
      subIndex: page.nextSubIndex,
    });
    if (page.items.length === 0) {
      if (newestReadMessageId === decoded.messageId) {
        if (page.nextIndex > startIndex) return gap();
        return latest.nextCursor === null ? { outcome: 'already_current' } : gap();
      }
      return {
        outcome: 'advanced',
        items: [],
        nextCursor,
        boundary: newestReadMessageId ?? `index:${page.nextIndex}`,
        hasMore: page.truncated,
        diagnostics: [
          ...(knownNonTranscriptPositions.length > 0
            ? [{
                code: 'non_transcript_record_skipped',
                severity: 'benign' as const,
                count: knownNonTranscriptPositions.length,
                positions: knownNonTranscriptPositions.slice(0, 200),
              }]
            : []),
          ...(unsupportedPositions.length > 0
            ? [{
                code: 'unsupported_record_skipped',
                severity: 'required' as const,
                count: unsupportedPositions.length,
                positions: unsupportedPositions.slice(0, 200),
              }]
            : []),
        ],
      };
    }
    return {
      outcome: 'advanced',
      items: page.items,
      nextCursor,
      boundary: page.items.at(-1)!.id,
      hasMore: page.truncated,
      ...(knownNonTranscriptPositions.length > 0 || unsupportedPositions.length > 0
        ? {
            diagnostics: [
              ...(knownNonTranscriptPositions.length > 0
                ? [{
                    code: 'non_transcript_record_skipped',
                    severity: 'benign' as const,
                    count: knownNonTranscriptPositions.length,
                    positions: knownNonTranscriptPositions.slice(0, 200),
                  }]
                : []),
              ...(unsupportedPositions.length > 0
                ? [{
                    code: 'unsupported_record_skipped',
                    severity: 'required' as const,
                    count: unsupportedPositions.length,
                    positions: unsupportedPositions.slice(0, 200),
                  }]
                : []),
            ],
          }
        : {}),
    };
  } finally {
    await client.dispose().catch(() => {});
  }
}
