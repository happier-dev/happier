import type {
  ExternalSessionsSource,
  ExternalSessionTranscriptRawMessageV1,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import {
  readOpenCodeTranscriptForwardWindow,
} from '../../../runtime/server/transcript/indexedTranscript.js';
import {
  classifyOpenCodeMessageForProjection,
} from '../../../runtime/server/transcript/projection/index.js';
import { createOpenCodeExternalSessionClient } from './client.js';
import {
  mapOpenCodeMessageToExternalSessionItem,
  measureOpenCodeExternalTranscriptItemBytes,
} from './messages.js';

export type OpenCodeAfterCursorV3 = Readonly<{
  v: 3;
  kind: 'opencodeAfter';
  messageId: string | null;
  sessionCreatedAtMs: number;
}>;

export function encodeOpenCodeExternalAfterCursor(value: OpenCodeAfterCursorV3): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeOpenCodeExternalAfterCursor(raw: string): OpenCodeAfterCursorV3 | null {
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    if (Reflect.get(decoded, 'v') !== 3 || Reflect.get(decoded, 'kind') !== 'opencodeAfter') return null;
    const messageId = Reflect.get(decoded, 'messageId');
    const sessionCreatedAtMs = Reflect.get(decoded, 'sessionCreatedAtMs');
    return (
      messageId === null || (typeof messageId === 'string' && messageId.length > 0)
    ) && typeof sessionCreatedAtMs === 'number'
      && Number.isSafeInteger(sessionCreatedAtMs)
      && sessionCreatedAtMs >= 0
      ? { v: 3, kind: 'opencodeAfter', messageId, sessionCreatedAtMs }
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
      items: readonly ExternalSessionTranscriptRawMessageV1[];
      nextCursor: string;
      boundary: string;
      diagnostics?: readonly Readonly<{ code: string; count: number; positions: readonly number[] }>[];
    }>
  | Readonly<{ outcome: 'gap_or_cursor_expired' }>
  | Readonly<{ outcome: 'source_replaced' }>
  | Readonly<{ outcome: 'source_unavailable' }>
  | Readonly<{ outcome: 'read_failed' }>;

function gap(): OpenCodeExternalReadAfterOutcome {
  return { outcome: 'gap_or_cursor_expired' };
}

export async function readAfterOpenCodeTranscript(params: Readonly<{
  source: ExternalSessionsSource;
  providerSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
}>): Promise<OpenCodeExternalReadAfterOutcome> {
  const client = await createOpenCodeExternalSessionClient({
    source: params.source,
    ...(params.env ? { env: params.env } : {}),
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
    const startIndex = decoded.messageId === null
      ? 0
      : rawMessages.findIndex((message) => readOpenCodeMessageId(message) === decoded.messageId) + 1;
    if (decoded.messageId !== null && startIndex === 0) {
      return gap();
    }

    const knownNonTranscriptPositions: number[] = [];
    const unsupportedPositions: number[] = [];
    const page = readOpenCodeTranscriptForwardWindow<ExternalSessionTranscriptRawMessageV1>({
      messages: rawMessages,
      startIndex,
      maxBytes: params.maxBytes,
      maxItems,
      mapMessage: (message, index) => {
        const item = mapOpenCodeMessageToExternalSessionItem(message, params.providerSessionId);
        if (!item) {
          const projection = classifyOpenCodeMessageForProjection(message);
          (
            projection.kind === 'compaction_internal'
            || projection.kind === 'ignored_internal'
              ? knownNonTranscriptPositions
              : unsupportedPositions
          ).push(index);
        }
        return item;
      },
      measureItemBytes: measureOpenCodeExternalTranscriptItemBytes,
    });
    const newestReadMessageId = readOpenCodeMessageId(rawMessages.at(page.nextIndex - 1))
      ?? decoded.messageId;
    const nextCursor = encodeOpenCodeExternalAfterCursor({
      v: 3,
      kind: 'opencodeAfter',
      messageId: newestReadMessageId,
      sessionCreatedAtMs,
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
        diagnostics: [
          ...(knownNonTranscriptPositions.length > 0
            ? [{
                code: 'non_transcript_record_skipped',
                count: knownNonTranscriptPositions.length,
                positions: knownNonTranscriptPositions.slice(0, 200),
              }]
            : []),
          ...(unsupportedPositions.length > 0
            ? [{
                code: 'unsupported_record_skipped',
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
      ...(knownNonTranscriptPositions.length > 0 || unsupportedPositions.length > 0
        ? {
            diagnostics: [
              ...(knownNonTranscriptPositions.length > 0
                ? [{
                    code: 'non_transcript_record_skipped',
                    count: knownNonTranscriptPositions.length,
                    positions: knownNonTranscriptPositions.slice(0, 200),
                  }]
                : []),
              ...(unsupportedPositions.length > 0
                ? [{
                    code: 'unsupported_record_skipped',
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
