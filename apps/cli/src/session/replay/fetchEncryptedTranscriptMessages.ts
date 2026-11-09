import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from '@/api/client/credentialAxios';

import { createAuthenticationHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildSessionMessagesPath, SessionMessagesPageV1Schema, SessionExternalShareableMessagesPageV1Schema, type SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { isExternalShareableTranscriptWirePayloadWithinLimitV1 } from '@happier-dev/protocol/sessions/messages/sessionExternalShareableTranscriptV1';
import type { ExternalShareableTranscriptSnapshotV1 } from '@happier-dev/protocol';
import {
  createSessionTranscriptStoredContentUnavailableError,
  throwIfSessionTranscriptStoredContentUnavailableResponse,
} from '@/api/session/sessionTranscriptStoredContentUnavailable';

export const DEFAULT_TRANSCRIPT_FETCH_TIMEOUT_MS = 10_000;
// Released server-v0.2.1 caps each messages page at 500 rows.
export const MAX_TRANSCRIPT_MESSAGES_PAGE_SIZE = 500;
const MAX_NATIVE_TIMER_DELAY_MS = 2_147_483_647;

export function resolveTranscriptFetchTimeoutMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.trunc(value))
    : DEFAULT_TRANSCRIPT_FETCH_TIMEOUT_MS;
}

export async function withTranscriptReadDeadline<T>(
  params: Readonly<{ deadlineAtMs: number; signal?: AbortSignal }>,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromCaller = () => controller.abort(params.signal?.reason);
  const checkDeadline = () => {
    const remainingMs = params.deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      controller.abort(new Error('Transcript read deadline exceeded'));
      return;
    }
    // Chunk only the native timer range; the caller's deadline stays intact.
    timer = setTimeout(checkDeadline, Math.min(remainingMs, MAX_NATIVE_TIMER_DELAY_MS));
    timer.unref?.();
  };
  if (params.signal?.aborted) abortFromCaller();
  else params.signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    controller.signal.throwIfAborted();
    checkDeadline();
    controller.signal.throwIfAborted();
    const result = await read(controller.signal);
    if (Date.now() >= params.deadlineAtMs) controller.abort(new Error('Transcript read deadline exceeded'));
    controller.signal.throwIfAborted();
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    params.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export type RawTranscriptRow = Readonly<{
  id?: unknown;
  seq?: unknown;
  localId?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  content?: unknown;
  messageRole?: unknown;
  sidechainId?: unknown;
  surfaceItemReference?: unknown;
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

type FetchEncryptedTranscriptMessagesPageParams = Readonly<{
  token: string;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'GET'; path: string;
  }>) => Readonly<Record<string, string>> | null;
  sessionId: string;
  limit: number;
  messageId?: string;
  beforeSeq?: number;
  afterSeq?: number;
  scope?: 'main' | 'sidechain' | 'all';
  sidechainId?: string | null;
  role?: 'user' | 'agent' | 'event' | 'unknown';
  roles?: readonly ('user' | 'agent' | 'event' | 'unknown')[];
  projection?: 'externalShareableV1';
  signal?: AbortSignal;
  deadlineAtMs?: number;
  timeoutMs?: number;
}>;

export function fetchEncryptedTranscriptMessagesPage(
  params: FetchEncryptedTranscriptMessagesPageParams & Readonly<{ projection?: undefined }>,
): Promise<Omit<FetchEncryptedTranscriptMessagesPageResult, 'messages'> & Readonly<{ messages: readonly SessionMessageV1[] }>>;
export function fetchEncryptedTranscriptMessagesPage(
  params: FetchEncryptedTranscriptMessagesPageParams,
): Promise<FetchEncryptedTranscriptMessagesPageResult>;
export async function fetchEncryptedTranscriptMessagesPage(params: FetchEncryptedTranscriptMessagesPageParams): Promise<FetchEncryptedTranscriptMessagesPageResult> {
  params.signal?.throwIfAborted();
  const timeoutMs = params.deadlineAtMs === undefined
    ? resolveTranscriptFetchTimeoutMs(params.timeoutMs)
    : Math.floor(params.deadlineAtMs - Date.now());
  if (timeoutMs <= 0) throw new Error('Transcript read deadline exceeded');
  const deadlineAtMs = params.deadlineAtMs ?? Date.now() + timeoutMs;
  return await withTranscriptReadDeadline({ deadlineAtMs, signal: params.signal }, async (signal) => {
    const serverUrl = resolveServerHttpBaseUrl();
    const beforeSeq = typeof params.beforeSeq === 'number' && Number.isFinite(params.beforeSeq)
      ? Math.max(0, Math.floor(params.beforeSeq)) : undefined;
    const afterSeq = typeof params.afterSeq === 'number' && Number.isFinite(params.afterSeq)
      ? Math.max(0, Math.floor(params.afterSeq)) : undefined;
    const path = buildSessionMessagesPath({
      sessionId: params.sessionId,
      ...(params.messageId !== undefined ? { messageId: params.messageId } : {}),
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
      // The signal owns deadlines beyond the native request timer range.
      timeout: timeoutMs <= MAX_NATIVE_TIMER_DELAY_MS ? timeoutMs : 0,
      signal,
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
    if (params.messageId !== undefined && (page.data.messages.length > 1
      || page.data.messages.some(row => row.id !== params.messageId)
      || page.data.hasMore || nextBeforeSeq !== null || nextAfterSeq !== null)) {
      throw createSessionTranscriptStoredContentUnavailableError();
    }
    // Ordinary released pages prove completeness explicitly. Unlike the separate
    // external-shareable projection, they cannot carry a blocked continuation.
    if (page.data.hasMore && (page.data.messages.length === 0 || (afterSeq !== undefined
      ? nextAfterSeq === null || nextAfterSeq <= afterSeq
      : nextBeforeSeq === null || (beforeSeq !== undefined && nextBeforeSeq >= beforeSeq)))) {
      throw createSessionTranscriptStoredContentUnavailableError();
    }
    if (page.data.hasMore) {
      const boundarySeq = afterSeq !== undefined
        ? Math.max(...page.data.messages.map(row => row.seq))
        : Math.min(...page.data.messages.map(row => row.seq));
      if ((afterSeq !== undefined ? nextAfterSeq : nextBeforeSeq) !== boundarySeq) {
        throw createSessionTranscriptStoredContentUnavailableError();
      }
    }
    return {
      messages: page.data.messages,
      hasMore: page.data.hasMore,
      nextBeforeSeq,
      nextAfterSeq,
    };
  });
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
