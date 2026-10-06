import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';

import { createAuthenticationHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildSessionMessagesPath, SessionMessagesPageV1Schema, SessionExternalShareableMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { isExternalShareableTranscriptWirePayloadWithinLimitV1 } from '@happier-dev/protocol/sessions/messages/sessionExternalShareableTranscriptV1';
import type { ExternalShareableTranscriptSnapshotV1 } from '@happier-dev/protocol';
import {
  createSessionTranscriptStoredContentUnavailableError,
  throwIfSessionTranscriptStoredContentUnavailableResponse,
} from '@/api/session/sessionTranscriptStoredContentUnavailable';

export type RawTranscriptRow = Readonly<{
  id?: unknown;
  seq?: unknown;
  localId?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  content?: unknown;
  messageRole?: unknown;
  sidechainId?: unknown;
  externalShareableActor?: unknown;
  accountActor?: unknown;
}>;

export type FetchEncryptedTranscriptMessagesPageResult = Readonly<{
  messages: readonly RawTranscriptRow[];
  hasMore: boolean;
  nextBeforeSeq: number | null;
  nextAfterSeq: number | null;
  publicationBlocked?: boolean;
  externalShareableSnapshot?: ExternalShareableTranscriptSnapshotV1;
}>;

export async function fetchEncryptedTranscriptMessagesPage(params: Readonly<{
  token: string;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'GET'; path: string;
  }>) => Readonly<Record<string, string>> | null;
  sessionId: string;
  limit: number;
  beforeSeq?: number;
  afterSeq?: number;
  scope?: 'main' | 'sidechain' | 'all';
  sidechainId?: string | null;
  role?: 'user' | 'agent' | 'event' | 'unknown';
  roles?: readonly ('user' | 'agent' | 'event' | 'unknown')[];
  projection?: 'externalShareableV1';
  signal?: AbortSignal;
  deadlineAtMs?: number;
}>): Promise<FetchEncryptedTranscriptMessagesPageResult> {
  const serverUrl = resolveServerHttpBaseUrl();
  const beforeSeq = typeof params.beforeSeq === 'number' && Number.isFinite(params.beforeSeq)
    ? Math.max(0, Math.floor(params.beforeSeq)) : undefined;
  const afterSeq = typeof params.afterSeq === 'number' && Number.isFinite(params.afterSeq)
    ? Math.max(0, Math.floor(params.afterSeq)) : undefined;
  const remainingMs = params.deadlineAtMs === undefined
    ? null
    : Math.floor(params.deadlineAtMs - Date.now());
  if (params.signal?.aborted || (remainingMs !== null && remainingMs <= 0)) {
    const error = new Error('Transcript page read was cancelled');
    error.name = 'AbortError';
    throw error;
  }
  const path = buildSessionMessagesPath({
    sessionId: params.sessionId,
    scope: params.scope ?? 'main',
    limit: params.limit,
    ...(beforeSeq !== undefined ? { beforeSeq } : {}),
    ...(afterSeq !== undefined ? { afterSeq } : {}),
    ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}),
    ...(params.role ? { role: params.role } : {}),
    ...(params.roles?.length ? { roles: params.roles } : {}),
    ...(params.projection ? { projection: params.projection } : {}),
  });
  const authorizationHeaders = params.resolveAuthorizationHeaders?.({ method: 'GET', path })
    ?? (params.resolveAuthorizationHeaders ? null : { Authorization: `Bearer ${params.token}` });
  if (!authorizationHeaders) throw new Error('External Action authorization unavailable');
  const response = await axios.get(`${serverUrl}${path}`, {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      ...authorizationHeaders,
      'Content-Type': 'application/json',
    },
    timeout: remainingMs === null ? 10_000 : Math.min(10_000, remainingMs),
    ...(params.signal ? { signal: params.signal } : {}),
    validateStatus: () => true,
  });

  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(response.status, 'Authentication failed while fetching transcript messages');
  }
  throwIfSessionTranscriptStoredContentUnavailableResponse(response.status, response.data);
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v1/sessions/:id/messages: ${response.status}`);
  }
  if (
    params.projection === 'externalShareableV1'
    && !isExternalShareableTranscriptWirePayloadWithinLimitV1(response.data)
  ) {
    throw createSessionTranscriptStoredContentUnavailableError();
  }

  if (params.projection === 'externalShareableV1') {
    const page = SessionExternalShareableMessagesPageV1Schema.safeParse(response.data);
    if (!page.success) throw createSessionTranscriptStoredContentUnavailableError();
    return {
      messages: page.data.messages,
      hasMore: page.data.hasMore ?? false,
      nextBeforeSeq: page.data.nextBeforeSeq ?? null,
      nextAfterSeq: page.data.nextAfterSeq ?? null,
      publicationBlocked: page.data.publicationBlocked === true,
      ...(page.data.externalShareableSnapshot ? { externalShareableSnapshot: page.data.externalShareableSnapshot } : {}),
    };
  }
  const page = SessionMessagesPageV1Schema.safeParse(response.data);
  if (!page.success || typeof page.data.hasMore !== 'boolean') throw createSessionTranscriptStoredContentUnavailableError();
  const nextBeforeSeq = page.data.nextBeforeSeq ?? null;
  const nextAfterSeq = page.data.nextAfterSeq ?? null;
  // Ordinary released pages prove completeness explicitly. Unlike the separate
  // external-shareable projection, they cannot carry a blocked continuation.
  if (page.data.hasMore && (page.data.messages.length === 0 || (afterSeq !== undefined
    ? nextAfterSeq === null || nextAfterSeq <= afterSeq
    : nextBeforeSeq === null || (beforeSeq !== undefined && nextBeforeSeq >= beforeSeq)))) {
    throw createSessionTranscriptStoredContentUnavailableError();
  }
  return {
    messages: page.data.messages,
    hasMore: page.data.hasMore,
    nextBeforeSeq,
    nextAfterSeq,
  };
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
