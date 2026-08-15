import type { Credentials } from '@/persistence';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';

import { fetchTranscriptSemanticPage } from './transcript/fetchTranscriptSemanticPage';
import { resolveSessionTransportContext } from './resolveSessionTransportContext';

import {
  type CompactHistoryRow,
  extractCompactRow,
  extractRawRow,
  isHistoryArtifactDecryptedRow,
  type RawHistoryRow,
  tryResolveDecryptedTranscriptPayload,
} from './transcript/transcriptHistoryRows';

export type { RawHistoryRow } from './transcript/transcriptHistoryRows';

export type GetSessionHistoryResult =
  | Readonly<{ ok: true; sessionId: string; format: 'compact'; messages: readonly CompactHistoryRow[] }>
  | Readonly<{ ok: true; sessionId: string; format: 'raw'; messages: readonly RawHistoryRow[] }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'unsupported'; candidates?: string[] }>;

function normalizeRawRowSeq(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : Number.MAX_SAFE_INTEGER;
}

function sortHistoryRowsByTranscriptOrder<Row>(
  rows: readonly Row[],
  rowSeqs: ReadonlyMap<Row, number>,
): Row[] {
  return [...rows].sort((left, right) => (rowSeqs.get(left) ?? 0) - (rowSeqs.get(right) ?? 0));
}

async function readSessionHistoryRows(params: Readonly<{
  token: string;
  sessionId: string;
  ctx: Readonly<{ encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }>;
  limit: number;
  format: 'compact' | 'raw';
  includeMeta: boolean;
  includeStructuredPayload: boolean;
}>): Promise<readonly (CompactHistoryRow | RawHistoryRow)[]> {
  const limit = Math.max(1, Math.floor(params.limit));
  const rows: Array<CompactHistoryRow | RawHistoryRow> = [];
  const rowSeqs = new Map<CompactHistoryRow | RawHistoryRow, number>();
  let beforeSeq: number | undefined;
  let scanned = 0;
  const maxRawRowsToScan = Math.max(limit, limit * 20);

  while (rows.length < limit && scanned < maxRawRowsToScan) {
    const page = await fetchEncryptedTranscriptMessagesPage({
      token: params.token,
      sessionId: params.sessionId,
      limit: Math.min(200, maxRawRowsToScan - scanned),
      ...(typeof beforeSeq === 'number' ? { beforeSeq } : {}),
      scope: 'all',
    });
    if (page.messages.length === 0) break;

    for (const row of page.messages) {
      scanned += 1;
      const decrypted = tryResolveDecryptedTranscriptPayload({
        content: row.content,
        ctx: params.ctx,
      });
      if (decrypted === null || isHistoryArtifactDecryptedRow(decrypted)) continue;

      const fallbackId = typeof row.id === 'string'
        ? row.id
        : typeof row.localId === 'string'
          ? row.localId
          : `seq:${normalizeRawRowSeq(row.seq)}`;
      const createdAt = typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)
        ? row.createdAt
        : 0;
      const historyRow = params.format === 'raw'
        ? extractRawRow({
            decrypted,
            createdAt,
            fallbackId,
            includeMeta: params.includeMeta,
            includeStructuredPayload: params.includeStructuredPayload,
          })
        : extractCompactRow({
            decrypted,
            createdAt,
            fallbackId,
          });
      if (!historyRow) continue;
      rows.push(historyRow);
      rowSeqs.set(historyRow, normalizeRawRowSeq(row.seq));
      if (rows.length >= limit) break;
    }

    if (!page.hasMore || page.nextBeforeSeq === null) break;
    beforeSeq = page.nextBeforeSeq;
  }

  return sortHistoryRowsByTranscriptOrder(rows, rowSeqs);
}

export async function readRawSessionHistoryRows(params: Readonly<{
  token: string;
  sessionId: string;
  ctx: Readonly<{ encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }>;
  limit: number;
  includeMeta?: boolean;
  includeStructuredPayload?: boolean;
}>): Promise<readonly RawHistoryRow[]> {
  const page = await fetchTranscriptSemanticPage({
    token: params.token,
    sessionId: params.sessionId,
    ctx: params.ctx,
    limit: params.limit,
    rawPageLimit: Math.min(200, Math.max(1, params.limit)),
    maxRawRowsToScan: Math.max(1, params.limit),
    direction: 'before',
    scope: 'all',
    mode: 'events',
    includeRaw: true,
    includeStructuredPayload: params.includeStructuredPayload === true,
    maxPayloadChars: 32768,
  });

  return page.items.map((item) => ({
    id: item.id,
    createdAt: item.createdAt,
    role: item.storedMessageRole ?? item.semanticRole,
    raw: item.raw && typeof item.raw === 'object' && !Array.isArray(item.raw)
      ? item.raw as Record<string, unknown>
      : { value: item.raw },
  }));
}

export async function getSessionHistory(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  limit: number;
  format: 'compact' | 'raw';
  includeMeta: boolean;
  includeStructuredPayload: boolean;
}>): Promise<GetSessionHistoryResult> {
  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
  });
  if (!sessionTarget.ok) {
    return {
      ok: false,
      code: sessionTarget.code,
      ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
    };
  }

  const messages = await readSessionHistoryRows({
    token: params.credentials.token,
    sessionId: sessionTarget.sessionId,
    ctx: sessionTarget.ctx,
    limit: params.limit,
    format: params.format,
    includeMeta: params.includeMeta,
    includeStructuredPayload: params.includeStructuredPayload,
  });

  if (params.format === 'raw') {
    return {
      ok: true,
      sessionId: sessionTarget.sessionId,
      format: 'raw',
      messages: messages as readonly RawHistoryRow[],
    };
  }

  return {
    ok: true,
    sessionId: sessionTarget.sessionId,
    format: 'compact',
    messages: messages as readonly CompactHistoryRow[],
  };
}
