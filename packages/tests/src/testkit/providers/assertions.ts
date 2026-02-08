import { fetchAllMessages, type SessionMessageRow } from '../sessions';
import { decryptLegacyBase64 } from '../messageCrypto';
import { sleep } from '../timing';

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
  if (!decoded || typeof decoded !== 'object') return null;
  return decoded as DecryptedSessionMessage;
}

export function isAcpSidechainMessage(msg: DecryptedSessionMessage, sidechainId: string): boolean {
  const content = msg?.content;
  if (!content || typeof content !== 'object') return false;
  if (content.type !== 'acp') return false;
  const data = (content as any).data;
  if (!data || typeof data !== 'object') return false;
  return (data as any).sidechainId === sidechainId;
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
    const rows = await fetchAllMessages(params.baseUrl, params.token, params.sessionId);
    const messages = rows
      .map((row) => decryptSessionMessageLegacy(row, params.secret))
      .filter((m): m is DecryptedSessionMessage => Boolean(m))
      .filter((m) => isAcpSidechainMessage(m, params.sidechainId));
    if (messages.length > 0) return { rows, messages };
    await sleep(500);
  }
  const rows = await fetchAllMessages(params.baseUrl, params.token, params.sessionId);
  const messages = rows
    .map((row) => decryptSessionMessageLegacy(row, params.secret))
    .filter((m): m is DecryptedSessionMessage => Boolean(m))
    .filter((m) => isAcpSidechainMessage(m, params.sidechainId));
  return { rows, messages };
}
