import type { Credentials } from '@/persistence';

import { getSessionEvents } from './getSessionEvents';
import { fetchTranscriptSemanticPage } from './transcript/fetchTranscriptSemanticPage';

import {
  type CompactHistoryRow,
  type RawHistoryRow,
} from './transcript/transcriptHistoryRows';

export type { RawHistoryRow } from './transcript/transcriptHistoryRows';

export type GetSessionHistoryResult =
  | Readonly<{ ok: true; sessionId: string; format: 'compact'; messages: readonly CompactHistoryRow[] }>
  | Readonly<{ ok: true; sessionId: string; format: 'raw'; messages: readonly RawHistoryRow[] }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'unsupported'; candidates?: string[] }>;

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
  if (params.format === 'raw') {
    const events = await getSessionEvents({
      credentials: params.credentials,
      idOrPrefix: params.idOrPrefix,
      limit: params.limit,
      includeRaw: true,
      includeMeta: params.includeMeta,
      includeStructuredPayload: params.includeStructuredPayload,
    });
    if (!events.ok) {
      return {
        ok: false,
        code: events.errorCode === 'session_id_ambiguous' ? 'session_id_ambiguous' : events.errorCode === 'session_not_found' ? 'session_not_found' : 'unsupported',
        ...(events.candidates ? { candidates: events.candidates } : {}),
      };
    }

    return {
      ok: true,
      sessionId: events.sessionId,
      format: 'raw',
      messages: events.items.map((item) => ({
        id: item.id,
        createdAt: item.createdAt,
        role: item.storedMessageRole ?? item.semanticRole,
        raw: item.raw && typeof item.raw === 'object' && !Array.isArray(item.raw)
          ? item.raw as Record<string, unknown>
          : { value: item.raw },
      })),
    };
  }

  const events = await getSessionEvents({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    limit: params.limit,
    includeMeta: params.includeMeta,
    includeStructuredPayload: params.includeStructuredPayload,
  });
  if (!events.ok) {
    return {
      ok: false,
      code: events.errorCode === 'session_id_ambiguous' ? 'session_id_ambiguous' : events.errorCode === 'session_not_found' ? 'session_not_found' : 'unsupported',
      ...(events.candidates ? { candidates: events.candidates } : {}),
    };
  }

  return {
    ok: true,
    sessionId: events.sessionId,
    format: 'compact',
    messages: events.items.map((item): CompactHistoryRow => ({
      id: item.id,
      createdAt: item.createdAt,
      role: item.storedMessageRole ?? item.semanticRole,
      kind: item.kind,
      text: item.text ?? item.summary ?? item.kind,
    })),
  };
}
