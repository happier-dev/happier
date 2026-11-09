import type { SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';

import { configuration } from '@/configuration';
import { fetchEncryptedTranscriptMessagesPage, resolveTranscriptFetchTimeoutMs } from '@/session/replay/fetchEncryptedTranscriptMessages';
import type { SessionMessageContent } from '../types';

export type TranscriptRow = Readonly<{
  seq: number;
  createdAt: number;
  content: SessionMessageContent;
  id?: string;
  localId?: string | null;
  sidechainId?: string | null;
}>;

type ResolveTranscriptAuthorizationHeaders = (request: Readonly<{
  method: 'GET';
  path: string;
}>) => Readonly<Record<string, string>> | null;

export type FetchEncryptedTranscriptRangeResult =
  | Readonly<{ ok: true; rows: TranscriptRow[] }>
  | Readonly<{ ok: false; errorCode: 'window_too_large'; maxMessages: number; requestedMessages: number }>;

function toTranscriptRows(rows: readonly SessionMessageV1[]): TranscriptRow[] {
  return rows.map(row => ({
    id: row.id,
    localId: row.localId ?? null,
    seq: row.seq,
    createdAt: Math.trunc(row.createdAt),
    content: row.content,
    ...(row.sidechainId !== undefined ? { sidechainId: row.sidechainId } : {}),
  }));
}

export async function fetchEncryptedTranscriptPageAfterSeq(params: Readonly<{
  token: string;
  sessionId: string;
  afterSeq: number;
  limit: number;
  sidechainId?: string;
  timeoutMs?: number;
  deadlineAtMs?: number;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: ResolveTranscriptAuthorizationHeaders;
}>): Promise<TranscriptRow[]> {
  const page = await fetchEncryptedTranscriptMessagesPage({
    ...params,
    timeoutMs: resolveTranscriptFetchTimeoutMs(params.timeoutMs),
    ...(params.sidechainId !== undefined ? { scope: 'sidechain' as const } : {}),
  });
  return toTranscriptRows(page.messages);
}

export async function fetchEncryptedTranscriptPageLatest(params: Readonly<{
  token: string;
  sessionId: string;
  limit: number;
  timeoutMs?: number;
  deadlineAtMs?: number;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: ResolveTranscriptAuthorizationHeaders;
}>): Promise<TranscriptRow[]> {
  const page = await fetchEncryptedTranscriptMessagesPage({
    ...params,
    timeoutMs: resolveTranscriptFetchTimeoutMs(params.timeoutMs),
  });
  return toTranscriptRows(page.messages);
}

export async function fetchEncryptedTranscriptPageBeforeSeq(params: Readonly<{
  token: string;
  sessionId: string;
  beforeSeq: number;
  limit: number;
  timeoutMs?: number;
  deadlineAtMs?: number;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: ResolveTranscriptAuthorizationHeaders;
}>): Promise<Readonly<{ rows: TranscriptRow[]; hasMore: boolean; nextBeforeSeq: number | null }>> {
  const page = await fetchEncryptedTranscriptMessagesPage({
    ...params,
    timeoutMs: resolveTranscriptFetchTimeoutMs(params.timeoutMs),
  });
  return { rows: toTranscriptRows(page.messages), hasMore: page.hasMore, nextBeforeSeq: page.nextBeforeSeq };
}

export async function fetchEncryptedTranscriptRange(params: Readonly<{
  token: string;
  sessionId: string;
  seqFrom: number;
  seqTo: number;
  resolveAuthorizationHeaders?: ResolveTranscriptAuthorizationHeaders;
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
    ...(params.resolveAuthorizationHeaders
      ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
      : {}),
  });
  return { ok: true, rows };
}
