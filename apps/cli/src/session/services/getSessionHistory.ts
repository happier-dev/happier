import type { Credentials } from '@/persistence';
import { decodeBase64, decrypt } from '@/api/encryption';
import { SessionMessageContentSchema } from '@/api/types';
import { fetchEncryptedTranscriptMessages } from '@/session/replay/fetchEncryptedTranscriptMessages';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';

export type CompactHistoryRow = Readonly<{
  id: string;
  createdAt: number;
  role: string;
  kind: string;
  text: string;
  structuredKind?: string;
}>;

export type RawHistoryRow = Readonly<{
  id: string;
  createdAt: number;
  role: string;
  raw: Record<string, unknown>;
}>;

export type GetSessionHistoryResult =
  | Readonly<{ ok: true; sessionId: string; format: 'compact'; messages: readonly CompactHistoryRow[] }>
  | Readonly<{ ok: true; sessionId: string; format: 'raw'; messages: readonly RawHistoryRow[] }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'unsupported'; candidates?: string[] }>;

function isMemoryArtifactDecryptedRow(value: unknown): boolean {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!obj) return false;
  const meta = obj.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const happier = (meta as Record<string, unknown>).happier;
  if (!happier || typeof happier !== 'object' || Array.isArray(happier)) return false;
  const kind = (happier as Record<string, unknown>).kind;
  return kind === 'session_summary_shard.v1' || kind === 'session_synopsis.v1';
}

function extractCompactRow(params: Readonly<{
  decrypted: unknown;
  createdAt: number;
  fallbackId: string;
}>): CompactHistoryRow | null {
  const obj = params.decrypted && typeof params.decrypted === 'object' && !Array.isArray(params.decrypted) ? (params.decrypted as any) : null;
  const role = typeof obj?.role === 'string' ? String(obj.role) : 'unknown';
  const happierKind = typeof obj?.meta?.happier?.kind === 'string' ? String(obj.meta.happier.kind) : undefined;

  const body = obj?.content;
  const kind = typeof body?.type === 'string' ? String(body.type) : 'unknown';
  const text = kind === 'text' && typeof body?.text === 'string' ? String(body.text) : '';

  return {
    id: params.fallbackId,
    createdAt: params.createdAt,
    role,
    kind,
    text,
    ...(happierKind ? { structuredKind: happierKind } : {}),
  };
}

function extractRawRow(params: Readonly<{
  decrypted: unknown;
  createdAt: number;
  fallbackId: string;
  includeMeta: boolean;
  includeStructuredPayload: boolean;
}>): RawHistoryRow | null {
  const obj = params.decrypted && typeof params.decrypted === 'object' && !Array.isArray(params.decrypted) ? (params.decrypted as any) : null;
  if (!obj) return null;
  const role = typeof obj.role === 'string' ? String(obj.role) : 'unknown';

  const raw: Record<string, unknown> = {};
  if (typeof obj.role === 'string') raw.role = obj.role;
  if (obj.content !== undefined) raw.content = obj.content;

  if (params.includeMeta) {
    const meta = obj.meta;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const metaOut: Record<string, unknown> = { ...(meta as Record<string, unknown>) };
      if (!params.includeStructuredPayload) {
        const happier = metaOut.happier;
        if (happier && typeof happier === 'object' && !Array.isArray(happier) && 'payload' in happier) {
          delete (happier as Record<string, unknown>).payload;
        }
      }
      raw.meta = metaOut;
    }
  }

  return {
    id: params.fallbackId,
    createdAt: params.createdAt,
    role,
    raw,
  };
}

function tryResolveDecryptedTranscriptPayload(params: Readonly<{
  content: unknown;
  ctx: Readonly<{ encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }>;
}>): unknown | null {
  const parsed = SessionMessageContentSchema.safeParse(params.content);
  if (!parsed.success) return null;
  if (parsed.data.t === 'plain') return parsed.data.v;
  try {
    return decrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, decodeBase64(parsed.data.c, 'base64'));
  } catch {
    return null;
  }
}

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
