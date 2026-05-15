import type { Credentials } from '@/persistence';
import type { RawTranscriptRow } from '@/session/replay/fetchEncryptedTranscriptMessages';

import { getSessionTranscript } from './getSessionTranscript';
import { extractSemanticTranscriptItem } from './transcript/extractSemanticTranscriptItem';

export type SessionRecentMessageRow = Readonly<{
  id: string;
  createdAt: number;
  role: string;
  text: string;
}>;

export type GetSessionRecentMessagesResult =
  | Readonly<{ ok: true; sessionId: string; messages: readonly SessionRecentMessageRow[]; nextCursor: string | null }>
  | Readonly<{ ok: false; errorCode: string; errorMessage: string; candidates?: string[] }>;

function readPlainPayloadRole(row: RawTranscriptRow): string | null {
  const content = row.content && typeof row.content === 'object' && !Array.isArray(row.content)
    ? row.content as { t?: unknown; v?: unknown }
    : null;
  if (content?.t !== 'plain' || !content.v || typeof content.v !== 'object' || Array.isArray(content.v)) {
    return null;
  }
  const role = (content.v as Record<string, unknown>).role;
  return typeof role === 'string' ? role : null;
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
    const extracted = extractSemanticTranscriptItem({
      row,
      index: i,
      ctx: params.ctx,
      options: {
        mode: 'transcript',
        transcriptRoles: [
          ...(params.includeUser ? ['user' as const] : []),
          ...(params.includeAssistant ? ['assistant' as const] : []),
        ],
        maxTextChars: params.maxCharsPerMessage,
      },
    });
    const item = extracted.item;
    if (!item?.text) continue;
    out.push({
      id: item.id,
      createdAt: item.createdAt,
      role: readPlainPayloadRole(row) ?? item.role,
      text: item.text,
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
  const roles: Array<'user' | 'assistant'> = [];
  if (params.includeUser ?? true) roles.push('user');
  if (params.includeAssistant ?? true) roles.push('assistant');
  const transcript = await getSessionTranscript({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    ...(typeof params.limit === 'number' ? { limit: params.limit } : {}),
    ...(Object.prototype.hasOwnProperty.call(params, 'cursor') ? { cursor: params.cursor ?? null } : {}),
    roles,
    ...(Object.prototype.hasOwnProperty.call(params, 'maxCharsPerMessage') ? { maxCharsPerMessage: params.maxCharsPerMessage ?? null } : {}),
  });
  if (!transcript.ok) return transcript;
  return {
    ok: true,
    sessionId: transcript.sessionId,
    messages: transcript.items.map((item) => ({
      id: item.id,
      createdAt: item.createdAt,
      role: item.role,
      text: item.text ?? item.summary ?? '',
    })).filter((item) => item.text.length > 0),
    nextCursor: transcript.nextCursor,
  };
}
