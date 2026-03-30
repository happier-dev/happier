import type { Credentials } from '@/persistence';
import { fetchEncryptedTranscriptMessagesPage, type RawTranscriptRow } from '@/session/replay/fetchEncryptedTranscriptMessages';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';
import {
  extractCompactRow,
  isMemoryArtifactDecryptedRow,
  tryResolveDecryptedTranscriptPayload,
} from './transcript/transcriptHistoryRows';

export type SessionRecentMessageRow = Readonly<{
  id: string;
  createdAt: number;
  role: string;
  text: string;
}>;

export type GetSessionRecentMessagesResult =
  | Readonly<{ ok: true; sessionId: string; messages: readonly SessionRecentMessageRow[]; nextCursor: string | null }>
  | Readonly<{ ok: false; errorCode: string; errorMessage: string; candidates?: string[] }>;

function clampInt(value: unknown, params: Readonly<{ min: number; max: number; fallback: number }>): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return params.fallback;
  return Math.max(params.min, Math.min(params.max, Math.floor(parsed)));
}

function parseBeforeSeqCursor(cursor: string | null): number | undefined {
  if (!cursor) return undefined;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

export function extractRecentMessagesFromTranscriptRows(params: Readonly<{
  rows: readonly RawTranscriptRow[];
  ctx: Readonly<{ encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }>;
  includeUser: boolean;
  includeAssistant: boolean;
  maxCharsPerMessage: number | null;
}>): readonly SessionRecentMessageRow[] {
  const out: SessionRecentMessageRow[] = [];

  for (let i = 0; i < params.rows.length; i += 1) {
    const row = params.rows[i]!;
    const decrypted = tryResolveDecryptedTranscriptPayload({
      content: row.content,
      ctx: params.ctx,
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
    if (!extracted) continue;
    if (extracted.kind !== 'text') continue;
    if (!extracted.text) continue;

    const isUser = extracted.role === 'user';
    const include = isUser ? params.includeUser : params.includeAssistant;
    if (!include) continue;

    const text = params.maxCharsPerMessage === null
      ? extracted.text
      : extracted.text.slice(0, Math.max(0, params.maxCharsPerMessage));
    out.push({
      id: extracted.id,
      createdAt: extracted.createdAt,
      role: extracted.role,
      text,
    });
  }

  return out;
}

export async function getSessionRecentMessages(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  limit?: number;
  cursor?: string | null;
  includeUser?: boolean;
  includeAssistant?: boolean;
  maxCharsPerMessage?: number | null;
}>): Promise<GetSessionRecentMessagesResult> {
  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
  });
  if (!sessionTarget.ok) {
    return {
      ok: false,
      errorCode: sessionTarget.code,
      errorMessage: sessionTarget.code,
      ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
    };
  }

  const limit = clampInt(params.limit, { min: 1, max: 50, fallback: 20 });
  const beforeSeq = parseBeforeSeqCursor(params.cursor ?? null);

  const page = await fetchEncryptedTranscriptMessagesPage({
    token: params.credentials.token,
    sessionId: sessionTarget.sessionId,
    limit,
    ...(beforeSeq !== undefined ? { beforeSeq } : {}),
  });

  const includeUser = params.includeUser ?? true;
  const includeAssistant = params.includeAssistant ?? true;
  const maxCharsPerMessage =
    params.maxCharsPerMessage === null
      ? null
      : clampInt(params.maxCharsPerMessage, { min: 0, max: 50_000, fallback: 0 });

  const messagesDesc = extractRecentMessagesFromTranscriptRows({
    rows: page.messages,
    ctx: sessionTarget.ctx,
    includeUser,
    includeAssistant,
    maxCharsPerMessage,
  });

  const messages = messagesDesc.slice(0).reverse();
  const nextCursor = typeof page.nextBeforeSeq === 'number' ? String(page.nextBeforeSeq) : null;
  return { ok: true, sessionId: sessionTarget.sessionId, messages, nextCursor };
}
