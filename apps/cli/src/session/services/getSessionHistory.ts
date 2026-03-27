import type { Credentials } from '@/persistence';
import { fetchEncryptedTranscriptMessages } from '@/session/replay/fetchEncryptedTranscriptMessages';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';

import {
  extractCompactRow,
  extractRawRow,
  isMemoryArtifactDecryptedRow,
  tryResolveDecryptedTranscriptPayload,
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
  const rows = await fetchEncryptedTranscriptMessages({
    token: params.token,
    sessionId: params.sessionId,
    limit: params.limit,
  });

  const messages: RawHistoryRow[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const decrypted = tryResolveDecryptedTranscriptPayload({
      content: row.content,
      ctx: params.ctx,
    });
    if (!decrypted) continue;
    if (isMemoryArtifactDecryptedRow(decrypted)) continue;
    const createdAt = typeof row.createdAt === 'number' ? row.createdAt : 0;
    const id = typeof row.seq === 'number' || typeof row.seq === 'string' ? String(row.seq) : String(i);
    const extracted = extractRawRow({
      decrypted,
      createdAt,
      fallbackId: id,
      includeMeta: params.includeMeta === true,
      includeStructuredPayload: params.includeStructuredPayload === true,
    });
    if (extracted) messages.push(extracted);
  }

  return messages;
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

  if (params.format === 'raw') {
    const messages = await readRawSessionHistoryRows({
      token: params.credentials.token,
      sessionId: sessionTarget.sessionId,
      ctx: sessionTarget.ctx,
      limit: params.limit,
      includeMeta: params.includeMeta,
      includeStructuredPayload: params.includeStructuredPayload,
    });

    return {
      ok: true,
      sessionId: sessionTarget.sessionId,
      format: 'raw',
      messages,
    };
  }

  const rows = await fetchEncryptedTranscriptMessages({
    token: params.credentials.token,
    sessionId: sessionTarget.sessionId,
    limit: params.limit,
  });

  const messages: CompactHistoryRow[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const decrypted = tryResolveDecryptedTranscriptPayload({
      content: row.content,
      ctx: sessionTarget.ctx,
    });
    if (!decrypted) continue;
    if (isMemoryArtifactDecryptedRow(decrypted)) continue;
    const createdAt = typeof row.createdAt === 'number' ? row.createdAt : 0;
    const id = typeof row.seq === 'number' || typeof row.seq === 'string' ? String(row.seq) : String(i);
    const extracted = extractCompactRow({
      decrypted,
      createdAt,
      fallbackId: id,
    });
    if (extracted) messages.push(extracted);
  }

  return {
    ok: true,
    sessionId: sessionTarget.sessionId,
    format: 'compact',
    messages,
  };
}
