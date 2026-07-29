import axios from 'axios';

import { createAuthenticationHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

export type RawTranscriptRow = Readonly<{
  id?: unknown;
  seq?: unknown;
  createdAt?: unknown;
  content?: unknown;
  messageRole?: unknown;
  sidechainId?: unknown;
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
  scope?: 'main' | 'sidechain' | 'all';
  sidechainId?: string | null;
  role?: 'user' | 'agent' | 'event' | 'unknown';
  roles?: readonly ('user' | 'agent' | 'event' | 'unknown')[];
}>): Promise<FetchEncryptedTranscriptMessagesPageResult> {
  const serverUrl = resolveServerHttpBaseUrl();
  const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    params: {
      limit: params.limit,
      ...(typeof params.beforeSeq === 'number' && Number.isFinite(params.beforeSeq) ? { beforeSeq: Math.max(0, Math.floor(params.beforeSeq)) } : {}),
      ...(typeof params.afterSeq === 'number' && Number.isFinite(params.afterSeq) ? { afterSeq: Math.max(0, Math.floor(params.afterSeq)) } : {}),
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}),
      ...(params.role ? { role: params.role } : {}),
      ...(params.roles && params.roles.length > 0 ? { roles: params.roles.join(',') } : {}),
    },
    timeout: 10_000,
    validateStatus: () => true,
  });

  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(response.status, 'Authentication failed while fetching transcript messages');
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
  scope?: 'main' | 'sidechain' | 'all';
  sidechainId?: string | null;
  role?: 'user' | 'agent' | 'event' | 'unknown';
  roles?: readonly ('user' | 'agent' | 'event' | 'unknown')[];
}>): Promise<RawTranscriptRow[]> {
  return (await fetchEncryptedTranscriptMessagesPage(params)).messages as RawTranscriptRow[];
}
