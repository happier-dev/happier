import { logger } from '@/ui/logger';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';

import { extractSemanticTranscriptItem } from './extractSemanticTranscriptItem';
import type {
  SemanticTranscriptDiagnostics,
  SemanticTranscriptItem,
  StoredTranscriptRole,
  TranscriptDirection,
  TranscriptMode,
  TranscriptRawRow,
  TranscriptScope,
} from './semanticTranscriptItem';

export type FetchTranscriptRawPageParams = Readonly<{
  token: string;
  sessionId: string;
  limit: number;
  direction: TranscriptDirection;
  beforeSeq?: number;
  afterSeq?: number;
  scope: TranscriptScope;
  sidechainId?: string | null;
  roles?: readonly StoredTranscriptRole[];
}>;

export type FetchTranscriptRawPageResult = Readonly<{
  messages: readonly TranscriptRawRow[];
  hasMore: boolean;
  nextBeforeSeq: number | null;
  nextAfterSeq: number | null;
}>;

export type FetchTranscriptRawPage = (params: FetchTranscriptRawPageParams) => Promise<FetchTranscriptRawPageResult>;

export type FetchTranscriptSemanticPageResult = Readonly<{
  items: readonly SemanticTranscriptItem[];
  nextCursor: string | null;
  hasMore: boolean;
  diagnostics: SemanticTranscriptDiagnostics;
}>;

const SCAN_BUDGET_EXHAUSTED_EVENT = 'session_transcript_scan_budget_exhausted';
const RAW_PAYLOAD_TRUNCATED_EVENT = 'session_events_payload_truncated';

function parseCursor(cursor: string | null | undefined): number | undefined {
  if (cursor === null || cursor === undefined || cursor === '') return undefined;
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== String(cursor).trim()) {
    throw new Error('invalid_cursor');
  }
  return parsed;
}

function defaultFetchTranscriptRawPage(params: FetchTranscriptRawPageParams): Promise<FetchTranscriptRawPageResult> {
  return fetchEncryptedTranscriptMessagesPage({
    token: params.token,
    sessionId: params.sessionId,
    limit: params.limit,
    ...(typeof params.beforeSeq === 'number' ? { beforeSeq: params.beforeSeq } : {}),
    ...(typeof params.afterSeq === 'number' ? { afterSeq: params.afterSeq } : {}),
    scope: params.scope,
    ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}),
    ...(params.roles && params.roles.length > 0 ? { roles: params.roles } : {}),
  });
}

function orderSemanticItems(items: readonly SemanticTranscriptItem[]): readonly SemanticTranscriptItem[] {
  return [...items].sort((left, right) => {
    if (typeof left.seq === 'number' && typeof right.seq === 'number') return left.seq - right.seq;
    return left.createdAt - right.createdAt;
  });
}

function recordSemanticPageDiagnostics(params: Readonly<{
  sessionId: string;
  mode: TranscriptMode;
  direction: TranscriptDirection;
  scope: TranscriptScope;
  limit: number;
  maxRawRowsToScan: number;
  rawRowsScanned: number;
  pagesFetched: number;
  scanLimitReached: boolean;
  payloadTruncations: number;
  maxPayloadChars?: number;
  maxTotalPayloadBytes: number;
}>): void {
  if (params.scanLimitReached) {
    logger.debug(SCAN_BUDGET_EXHAUSTED_EVENT, {
      sessionId: params.sessionId,
      mode: params.mode,
      direction: params.direction,
      scope: params.scope,
      limit: params.limit,
      maxRawRowsToScan: params.maxRawRowsToScan,
      rawRowsScanned: params.rawRowsScanned,
      pagesFetched: params.pagesFetched,
    });
  }

  if (params.payloadTruncations > 0) {
    logger.debug(RAW_PAYLOAD_TRUNCATED_EVENT, {
      sessionId: params.sessionId,
      mode: params.mode,
      limit: params.limit,
      rawRowsScanned: params.rawRowsScanned,
      pagesFetched: params.pagesFetched,
      payloadTruncations: params.payloadTruncations,
      ...(typeof params.maxPayloadChars === 'number' ? { maxPayloadChars: params.maxPayloadChars } : {}),
      maxTotalPayloadBytes: params.maxTotalPayloadBytes,
    });
  }
}

export async function fetchTranscriptSemanticPage(params: Readonly<{
  token: string;
  sessionId: string;
  ctx: Readonly<{ encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }>;
  limit: number;
  rawPageLimit: number;
  maxRawRowsToScan: number;
  direction: TranscriptDirection;
  cursor?: string | null;
  scope: TranscriptScope;
  sidechainId?: string | null;
  serverRoles?: readonly StoredTranscriptRole[];
  mode: TranscriptMode;
  transcriptRoles?: readonly ('user' | 'assistant')[];
  includeTools?: boolean;
  includeReasoning?: boolean;
  includeEvents?: boolean;
  includeRaw?: boolean;
  includeStructuredPayload?: boolean;
  eventKinds?: readonly string[];
  maxTextChars?: number | null;
  maxPayloadChars?: number;
  maxTotalPayloadBytes?: number;
  fetchPage?: FetchTranscriptRawPage;
}>): Promise<FetchTranscriptSemanticPageResult> {
  const limit = Math.max(0, Math.floor(params.limit));
  if (limit === 0) {
    return {
      items: [],
      nextCursor: null,
      hasMore: false,
      diagnostics: { rawRowsScanned: 0, pagesFetched: 0, scanLimitReached: false, payloadTruncations: 0 },
    };
  }

  const fetchPage = params.fetchPage ?? defaultFetchTranscriptRawPage;
  const rawPageLimit = Math.max(1, Math.floor(params.rawPageLimit));
  const maxRawRowsToScan = Math.max(1, Math.floor(params.maxRawRowsToScan));
  const items: SemanticTranscriptItem[] = [];
  let cursor = parseCursor(params.cursor);
  let nextCursor: string | null = null;
  let hasMore = false;
  let rawRowsScanned = 0;
  let pagesFetched = 0;
  let scanLimitReached = false;
  let payloadTruncations = 0;
  let totalPayloadBytes = 0;
  const maxTotalPayloadBytes = Math.max(0, Math.floor(params.maxTotalPayloadBytes ?? 256 * 1024));
  const eventKinds = params.eventKinds?.filter((kind) => kind.trim().length > 0);

  while (items.length < limit && rawRowsScanned < maxRawRowsToScan) {
    const page = await fetchPage({
      token: params.token,
      sessionId: params.sessionId,
      limit: Math.min(rawPageLimit, maxRawRowsToScan - rawRowsScanned),
      direction: params.direction,
      ...(params.direction === 'before' && cursor !== undefined ? { beforeSeq: cursor } : {}),
      ...(params.direction === 'after' ? { afterSeq: cursor ?? 0 } : {}),
      scope: params.scope,
      ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}),
      ...(params.serverRoles && params.serverRoles.length > 0 ? { roles: params.serverRoles } : {}),
    });
    pagesFetched += 1;

    nextCursor = params.direction === 'after'
      ? (typeof page.nextAfterSeq === 'number' ? String(page.nextAfterSeq) : null)
      : (typeof page.nextBeforeSeq === 'number' ? String(page.nextBeforeSeq) : null);
    hasMore = page.hasMore;

    for (let index = 0; index < page.messages.length && rawRowsScanned < maxRawRowsToScan; index += 1) {
      const row = page.messages[index]!;
      rawRowsScanned += 1;
      const rowSeq = typeof row.seq === 'number' && Number.isFinite(row.seq) ? Math.floor(row.seq) : null;
      const extracted = extractSemanticTranscriptItem({
        row,
        index,
        ctx: params.ctx,
        options: {
          mode: params.mode,
          ...(params.transcriptRoles ? { transcriptRoles: params.transcriptRoles } : {}),
          includeTools: params.includeTools === true,
          includeReasoning: params.includeReasoning === true,
          includeEvents: params.includeEvents === true,
          includeRaw: params.includeRaw === true,
          includeStructuredPayload: params.includeStructuredPayload === true,
          ...(params.maxTextChars !== undefined ? { maxTextChars: params.maxTextChars } : {}),
          ...(params.maxPayloadChars !== undefined ? { maxPayloadChars: params.maxPayloadChars } : {}),
        },
      });
      if (extracted.item) {
        if (eventKinds && eventKinds.length > 0 && !eventKinds.includes(extracted.item.kind)) {
          continue;
        }
        if (extracted.payloadTruncated) payloadTruncations += 1;
        if (extracted.payloadBytes > 0) {
          totalPayloadBytes += extracted.payloadBytes;
          if (totalPayloadBytes > maxTotalPayloadBytes && extracted.item.raw !== undefined) {
            payloadTruncations += 1;
            items.push({ ...extracted.item, raw: undefined, rawTruncated: true });
            continue;
          }
        }
        items.push(extracted.item);
      }
      if (items.length >= limit) {
        const hasUnscannedRowsInPage = index < page.messages.length - 1;
        if (hasUnscannedRowsInPage && rowSeq !== null) {
          nextCursor = String(rowSeq);
          hasMore = true;
        }
        break;
      }
    }

    if (!page.hasMore || nextCursor === null) break;
    cursor = Number.parseInt(nextCursor, 10);
  }

  if (items.length < limit && hasMore && rawRowsScanned >= maxRawRowsToScan) {
    scanLimitReached = true;
  }

  recordSemanticPageDiagnostics({
    sessionId: params.sessionId,
    mode: params.mode,
    direction: params.direction,
    scope: params.scope,
    limit,
    maxRawRowsToScan,
    rawRowsScanned,
    pagesFetched,
    scanLimitReached,
    payloadTruncations,
    ...(params.maxPayloadChars !== undefined ? { maxPayloadChars: params.maxPayloadChars } : {}),
    maxTotalPayloadBytes,
  });

  return {
    items: orderSemanticItems(items.slice(0, limit)),
    nextCursor,
    hasMore: hasMore || scanLimitReached,
    diagnostics: {
      rawRowsScanned,
      pagesFetched,
      scanLimitReached,
      payloadTruncations,
    },
  };
}
