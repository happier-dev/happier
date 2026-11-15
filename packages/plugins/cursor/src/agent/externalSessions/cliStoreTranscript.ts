import { createHash } from 'node:crypto';
import type {
  AgentExternalSessionsPageTranscriptRequest, AgentExternalSessionsReadAfterTranscriptRequest, AgentExternalSessionsResult,
  AgentExternalSessionsReadAfterTranscriptResult, AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/sessions/external';
import { createAgentExternalSessionsProducerOverflowFailure, isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import { isRecord } from '@happier-dev/plugin-sdk';
import {
  CursorCliStoreFormatError, decodeCursorCliMessage, discoverCursorCliStores, readCursorCliStoreMessages,
  readCursorCliStoreSignature, type CursorCliStoreConversation, type CursorCliStoreMessages,
} from './cliStore.js';

type StoreCursor = Readonly<{ v: 1; kind: 'cursorCliStore'; homeDir: string; id: string; position: number; prefix: string; signature: string }>;

const encode = (value: StoreCursor) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(raw: string | undefined | null): StoreCursor | null {
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (!isRecord(data) || data.v !== 1 || data.kind !== 'cursorCliStore' || typeof data.homeDir !== 'string' || typeof data.id !== 'string'
      || typeof data.position !== 'number' || !Number.isSafeInteger(data.position) || data.position < 0
      || typeof data.prefix !== 'string' || typeof data.signature !== 'string') return null;
    return data as StoreCursor;
  } catch { return null; }
}

/** Message blobs are content addressed, so the id list of a prefix proves that prefix is unchanged. */
const prefixHash = (ids: readonly string[], end: number) => createHash('sha256').update(ids.slice(0, end).join(',')).digest('base64url');

/** A transcript request belongs to the CLI store when its cursor is a store cursor. */
export function isCursorCliStoreCursor(cursor: string | undefined): boolean {
  return decode(cursor) !== null;
}

export async function findCursorCliStore(homeDir: string, id: string, signal: AbortSignal): Promise<CursorCliStoreConversation | null> {
  const matches = (await discoverCursorCliStores(homeDir, signal)).conversations.filter(store => store.id === id);
  return matches.length === 1 ? matches[0]! : null;
}

export const CURSOR_CLI_STORE_UNSUPPORTED = Object.freeze({
  ok: false as const, code: 'format_unsupported' as const, retryable: false, message: 'cursor_cli_store_format_unsupported',
});

function itemsFor(read: CursorCliStoreMessages, start: number, end: number) {
  const items = [];
  let partial = 0;
  for (let index = start; index < end; index += 1) {
    const decoded = decodeCursorCliMessage(read.messages[index], `cursor:cli:${index}:${read.messageIds[index]!.slice(0, 16)}`, read.head.createdAtMs);
    items.push(...decoded.items);
    if (decoded.partial) partial += 1;
  }
  return { items, partial };
}

function pageValue(params: Readonly<{ homeDir: string; store: CursorCliStoreConversation; read: CursorCliStoreMessages; signature: string;
  start: number; end: number; older: boolean }>): AgentExternalSessionsTranscriptPage {
  const { read } = params;
  const cursor = (position: number) => encode({ v: 1, kind: 'cursorCliStore', homeDir: params.homeDir, id: params.store.id, position,
    prefix: prefixHash(read.messageIds, position), signature: params.signature });
  const { items, partial } = itemsFor(read, params.start, params.end);
  const hasMore = params.older ? params.start > 0 : params.end < read.messageIds.length;
  return {
    items, nextCursor: hasMore ? cursor(params.older ? params.start : params.end) : null,
    tailCursor: cursor(read.messageIds.length), hasMore,
    ...(partial ? { diagnostics: [{ code: 'unsupported_native_record', severity: 'required' as const, count: partial, positions: [] }] } : {}),
  };
}

export async function pageCursorCliStoreTranscript(homeDir: string, request: AgentExternalSessionsPageTranscriptRequest): Promise<AgentExternalSessionsResult<AgentExternalSessionsTranscriptPage>> {
  const store = await findCursorCliStore(homeDir, request.remoteSessionId, request.signal);
  if (!store) return { ok: false, code: 'candidate_not_found' };
  const previous = request.cursor ? decode(request.cursor) : null;
  if (request.cursor && (!previous || previous.homeDir !== homeDir || previous.id !== store.id)) return { ok: false, code: 'invalid_request' };
  try {
    const signature = await readCursorCliStoreSignature(store);
    const read = readCursorCliStoreMessages(store);
    const total = read.messageIds.length;
    if (previous && (previous.position > total || prefixHash(read.messageIds, previous.position) !== previous.prefix)) return { ok: false, code: 'source_invalid' };
    const older = request.direction !== 'newer';
    for (let limit = Math.max(1, request.maxItems); ; limit = Math.max(1, Math.floor(limit / 2))) {
      const end = older ? previous?.position ?? total : Math.min(total, (previous?.position ?? 0) + limit);
      const start = older ? Math.max(0, end - limit) : previous?.position ?? 0;
      const value = pageValue({ homeDir, store, read, signature, start, end, older });
      const result = { ok: true as const, value };
      if (isAgentExternalSessionsResultWithinByteBudget(result, request.maxSerializedBytes)) return result;
      if (limit === 1) return createAgentExternalSessionsProducerOverflowFailure('Cursor transcript record exceeds the caller result budget.');
    }
  } catch (error) {
    if (error instanceof CursorCliStoreFormatError) return CURSOR_CLI_STORE_UNSUPPORTED;
    throw error;
  }
}

export async function readAfterCursorCliStoreTranscript(
  homeDir: string,
  request: AgentExternalSessionsReadAfterTranscriptRequest,
): Promise<AgentExternalSessionsResult<AgentExternalSessionsReadAfterTranscriptResult>> {
  const done = <T extends object>(value: T) => ({ ok: true as const, value });
  const previous = decode(request.cursor);
  if (!previous || previous.homeDir !== homeDir || previous.id !== request.remoteSessionId) return done({ outcome: 'gap_or_cursor_expired' as const });
  const store = await findCursorCliStore(homeDir, request.remoteSessionId, request.signal);
  if (!store) return done({ outcome: 'source_unavailable' as const });
  const signature = await readCursorCliStoreSignature(store);
  // No committed write reached the database or its WAL since this cursor.
  if (signature === previous.signature) return done({ outcome: 'already_current' as const });
  // The page re-verifies the delivered prefix; a changed prefix is a replacement.
  const page = await pageCursorCliStoreTranscript(homeDir, { ...request, direction: 'newer' } as AgentExternalSessionsPageTranscriptRequest);
  if (!page.ok) return page.code === 'source_invalid' ? done({ outcome: 'source_replaced' as const }) : page;
  if (!page.value.items.length && decode(page.value.tailCursor)?.position === previous.position) {
    return done({ outcome: 'already_current' as const });
  }
  return done({ outcome: 'advanced' as const, items: page.value.items, nextCursor: page.value.nextCursor ?? page.value.tailCursor!,
    boundary: store.id, hasMore: page.value.hasMore ?? false, diagnostics: page.value.diagnostics });
}
