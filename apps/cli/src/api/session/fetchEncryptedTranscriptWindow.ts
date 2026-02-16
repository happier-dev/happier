import axios from 'axios';

import { configuration } from '@/configuration';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';

export type EncryptedTranscriptRow = Readonly<{
  seq: number;
  createdAt: number;
  content: { t: 'encrypted'; c: string };
  id?: string;
  localId?: string | null;
}>;

type RawTranscriptRow = Readonly<{
  id?: unknown;
  seq?: unknown;
  localId?: unknown;
  createdAt?: unknown;
  content?: unknown;
}>;

export type FetchEncryptedTranscriptRangeResult =
  | Readonly<{ ok: true; rows: EncryptedTranscriptRow[] }>
  | Readonly<{ ok: false; errorCode: 'window_too_large'; maxMessages: number; requestedMessages: number }>;

function parseEncryptedTranscriptRows(raw: unknown): EncryptedTranscriptRow[] {
  if (!Array.isArray(raw)) return [];
  const out: EncryptedTranscriptRow[] = [];
  for (const entry of raw as RawTranscriptRow[]) {
    const seq = typeof entry?.seq === 'number' && Number.isFinite(entry.seq) ? Math.trunc(entry.seq) : null;
    const createdAt =
      typeof entry?.createdAt === 'number' && Number.isFinite(entry.createdAt) ? Math.trunc(entry.createdAt) : null;
    const content = entry?.content as any;
    const ciphertext = content && typeof content === 'object' && content.t === 'encrypted' ? content.c : null;
    if (seq === null || createdAt === null) continue;
    if (typeof ciphertext !== 'string' || ciphertext.trim().length === 0) continue;
    const id = typeof entry?.id === 'string' ? entry.id : undefined;
    const localId = typeof entry?.localId === 'string' ? entry.localId : null;
    out.push({
      id,
      localId,
      seq,
      createdAt,
      content: { t: 'encrypted', c: ciphertext },
    });
  }
  return out;
}

export async function fetchEncryptedTranscriptPageAfterSeq(params: Readonly<{
  token: string;
  sessionId: string;
  afterSeq: number;
  limit: number;
}>): Promise<EncryptedTranscriptRow[]> {
  const serverUrl = resolveLoopbackHttpUrl(configuration.serverUrl).replace(/\/+$/, '');
  const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    params: { afterSeq: params.afterSeq, limit: params.limit },
    timeout: 10_000,
    validateStatus: () => true,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Unauthorized (${response.status})`);
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v1/sessions/:id/messages: ${response.status}`);
  }

  return parseEncryptedTranscriptRows((response.data as any)?.messages);
}

export async function fetchEncryptedTranscriptPageLatest(params: Readonly<{
  token: string;
  sessionId: string;
  limit: number;
}>): Promise<EncryptedTranscriptRow[]> {
  const serverUrl = resolveLoopbackHttpUrl(configuration.serverUrl).replace(/\/+$/, '');
  const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    params: { limit: params.limit },
    timeout: 10_000,
    validateStatus: () => true,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Unauthorized (${response.status})`);
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v1/sessions/:id/messages: ${response.status}`);
  }

  return parseEncryptedTranscriptRows((response.data as any)?.messages);
}

export async function fetchEncryptedTranscriptRange(params: Readonly<{
  token: string;
  sessionId: string;
  seqFrom: number;
  seqTo: number;
}>): Promise<FetchEncryptedTranscriptRangeResult> {
  const seqFrom = Math.max(0, Math.trunc(params.seqFrom));
  const seqTo = Math.max(0, Math.trunc(params.seqTo));
  const requestedMessages = seqTo >= seqFrom ? (seqTo - seqFrom + 1) : 0;
  const maxMessages = configuration.memoryMaxTranscriptWindowMessages;

  if (requestedMessages <= 0) {
    return { ok: true, rows: [] };
  }

  if (requestedMessages > maxMessages) {
    return { ok: false, errorCode: 'window_too_large', maxMessages, requestedMessages };
  }

  const afterSeq = Math.max(0, seqFrom - 1);
  const limit = requestedMessages;
  const rows = await fetchEncryptedTranscriptPageAfterSeq({
    token: params.token,
    sessionId: params.sessionId,
    afterSeq,
    limit,
  });
  return { ok: true, rows };
}
