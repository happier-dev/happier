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

type DurableToolRow = Readonly<{ kind: 'call' | 'result'; key: string }>;

function readDurableToolRow(value: unknown): DurableToolRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  const envelope = message.content;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  const outer = envelope as Record<string, unknown>;
  const content = outer.type === 'acp' && outer.data && typeof outer.data === 'object' && !Array.isArray(outer.data)
    ? outer.data as Record<string, unknown>
    : outer;
  const type = content.type === 'tool-call' ? 'call' : content.type === 'tool-result' ? 'result' : null;
  const callId = typeof content.callId === 'string' ? content.callId : typeof content.toolCallId === 'string' ? content.toolCallId : null;
  if (!type || !callId) return null;
  const meta = message.meta;
  const namespace = meta && typeof meta === 'object' && !Array.isArray(meta) && typeof (meta as Record<string, unknown>).sidechainId === 'string'
    ? `sidechain:${(meta as Record<string, unknown>).sidechainId}` : 'main';
  return { kind: type, key: `${namespace}\u0000${callId}` };
}

/** Asserts the durable transcript, not the raw provider update count. */
export function assertDurableToolCardinality(messages: readonly unknown[], expected: Readonly<{ calls: number; results: number }>): void {
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const message of messages) {
    const row = readDurableToolRow(message);
    if (!row) continue;
    const target = row.kind === 'call' ? calls : results;
    target.set(row.key, (target.get(row.key) ?? 0) + 1);
  }
  if (calls.size !== expected.calls || results.size !== expected.results) {
    throw new Error(`Expected durable tool cardinality ${expected.calls}/${expected.results}, got ${calls.size}/${results.size}`);
  }
  const duplicates = [...calls, ...results].filter(([, count]) => count > 1);
  const orphans = [...results.keys()].filter((key) => !calls.has(key));
  if (duplicates.length || orphans.length) {
    throw new Error(`Unexpected durable tool identities: duplicates=${duplicates.length}, orphans=${orphans.length}`);
  }
}

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
