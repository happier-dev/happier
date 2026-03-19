import { fetchAllSidechainMessages, type SessionMessageRow } from '../sessions';
import { decryptLegacyBase64 } from '../messageCrypto';
import { sleep } from '../timing';
import { normalizeDecodedTranscriptValue } from './normalizeDecodedTranscriptValue';

export function hasStringSubstring(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((v) => hasStringSubstring(v, needle));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => hasStringSubstring(v, needle));
  }
  return false;
}

export type DecryptedSessionMessage = {
  role?: string;
  content?: any;
  meta?: Record<string, unknown>;
};

export function decryptSessionMessageLegacy(row: SessionMessageRow, secret: Uint8Array): DecryptedSessionMessage | null {
  const ciphertext = row?.content?.c;
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return null;
  const decoded = decryptLegacyBase64(ciphertext, secret);
  const normalized = normalizeDecodedTranscriptValue(decoded);
  if (!normalized || typeof normalized !== 'object') return null;
  return normalized as DecryptedSessionMessage;
}

export function isAcpSidechainMessage(msg: unknown, sidechainId: string): boolean {
  const normalized = normalizeDecodedTranscriptValue(msg);
  const content = normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? (normalized as Record<string, unknown>).content
    : null;
  if (!content || typeof content !== 'object') return false;
  const contentRecord = content as Record<string, unknown>;
  if (contentRecord.type !== 'acp') return false;
  const data = contentRecord.data;
  if (!data || typeof data !== 'object') return false;
  return (data as Record<string, unknown>).sidechainId === sidechainId;
}

export async function waitForAcpSidechainMessages(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  sidechainId: string;
  timeoutMs: number;
}): Promise<{ rows: SessionMessageRow[]; messages: DecryptedSessionMessage[] }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const rows = await fetchAllSidechainMessages({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      sidechainId: params.sidechainId,
    });
    const messages = rows
      .map((row) => decryptSessionMessageLegacy(row, params.secret))
      .filter((m): m is DecryptedSessionMessage => Boolean(m))
      .filter((m) => isAcpSidechainMessage(m, params.sidechainId));
    if (messages.length > 0) return { rows, messages };
    await sleep(500);
  }
  const rows = await fetchAllSidechainMessages({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    sidechainId: params.sidechainId,
  });
  const messages = rows
    .map((row) => decryptSessionMessageLegacy(row, params.secret))
    .filter((m): m is DecryptedSessionMessage => Boolean(m))
    .filter((m) => isAcpSidechainMessage(m, params.sidechainId));
  return { rows, messages };
}
