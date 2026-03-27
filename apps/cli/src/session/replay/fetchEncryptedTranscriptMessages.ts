import axios from 'axios';

import { configuration } from '@/configuration';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';

export type RawTranscriptRow = Readonly<{
  seq?: unknown;
  createdAt?: unknown;
  content?: unknown;
}>;

export type FetchEncryptedTranscriptMessagesPageResult = Readonly<{
  messages: readonly RawTranscriptRow[];
  hasMore: boolean;
  nextBeforeSeq: number | null;
  nextAfterSeq: number | null;
}>;

export async function fetchEncryptedTranscriptMessagesPage(params: Readonly<{
  token: string;
  sessionId: string;
  limit: number;
  beforeSeq?: number;
  afterSeq?: number;
}>): Promise<FetchEncryptedTranscriptMessagesPageResult> {
  const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
  const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    params: {
      limit: params.limit,
      ...(typeof params.beforeSeq === 'number' && Number.isFinite(params.beforeSeq) ? { beforeSeq: Math.max(0, Math.floor(params.beforeSeq)) } : {}),
      ...(typeof params.afterSeq === 'number' && Number.isFinite(params.afterSeq) ? { afterSeq: Math.max(0, Math.floor(params.afterSeq)) } : {}),
    },
    timeout: 10_000,
    validateStatus: () => true,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Unauthorized (${response.status})`);
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v1/sessions/:id/messages: ${response.status}`);
  }

  const raw = (response.data as any)?.messages;
  const messages = Array.isArray(raw) ? (raw as RawTranscriptRow[]) : [];
  const hasMore = (response.data as any)?.hasMore === true;
  const nextBeforeSeqRaw = (response.data as any)?.nextBeforeSeq;
  const nextAfterSeqRaw = (response.data as any)?.nextAfterSeq;
  const nextBeforeSeq = typeof nextBeforeSeqRaw === 'number' && Number.isFinite(nextBeforeSeqRaw) ? nextBeforeSeqRaw : null;
  const nextAfterSeq = typeof nextAfterSeqRaw === 'number' && Number.isFinite(nextAfterSeqRaw) ? nextAfterSeqRaw : null;

  return { messages, hasMore, nextBeforeSeq, nextAfterSeq };
}

export async function fetchEncryptedTranscriptMessages(params: Readonly<{
  token: string;
  sessionId: string;
  limit: number;
  beforeSeq?: number;
}>): Promise<RawTranscriptRow[]> {
  return (await fetchEncryptedTranscriptMessagesPage(params)).messages as RawTranscriptRow[];
}
