import axios from 'axios';

import { createAuthenticationHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

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
  timeoutMs?: number;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}>): Promise<FetchEncryptedTranscriptMessagesPageResult> {
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
    const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      params: {
        limit: params.limit,
        ...(beforeSeq !== undefined ? { beforeSeq } : {}),
        ...(afterSeq !== undefined ? { afterSeq } : {}),
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}),
        ...(params.role ? { role: params.role } : {}),
        ...(params.roles && params.roles.length > 0 ? { roles: params.roles.join(',') } : {}),
      },
      // The signal owns large deadlines that exceed Node's request timer range.
      timeout: timeoutMs <= MAX_NATIVE_TIMER_DELAY_MS ? timeoutMs : 0,
      signal,
      validateStatus: () => true,
    });

    if (isAuthenticationStatus(response.status)) {
      throw createAuthenticationHttpStatusError(response.status, `Unauthorized (${response.status})`);
    }
    if (response.status !== 200) {
      throw new Error(`Unexpected status from /v1/sessions/:id/messages: ${response.status}`);
    }

    // Released server-v0.2.1 returns an explicit page and continuation. A malformed
    // successful response is not proof of empty/complete committed history.
    const data: unknown = response.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('Invalid transcript messages page');
    }
    const page = data as Record<string, unknown>;
    if (!Array.isArray(page.messages) || typeof page.hasMore !== 'boolean') {
      throw new Error('Invalid transcript messages page');
    }
    const messages: RawTranscriptRow[] = page.messages.map((row: unknown) => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        throw new Error('Invalid transcript message row');
      }
      return row as Record<string, unknown>;
    });
    const hasMore = page.hasMore;
    const readCursor = (value: unknown): number | null => {
      if (value === undefined || value === null) return null;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error('Invalid transcript page cursor');
      }
      return value;
    };
    const nextBeforeSeq = readCursor(page.nextBeforeSeq);
    const nextAfterSeq = readCursor(page.nextAfterSeq);
    if (hasMore && (messages.length === 0 || (afterSeq !== undefined
      ? nextAfterSeq === null || nextAfterSeq <= afterSeq
      : nextBeforeSeq === null || (beforeSeq !== undefined && nextBeforeSeq >= beforeSeq)))) {
      throw new Error('Transcript page continuation cannot advance');
    }
    if (hasMore) {
      const sequences = messages.map((row) => {
        if (typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 0) {
          throw new Error('Invalid transcript message sequence');
        }
        return row.seq;
      });
      const boundarySeq = afterSeq !== undefined ? Math.max(...sequences) : Math.min(...sequences);
      if ((afterSeq !== undefined ? nextAfterSeq : nextBeforeSeq) !== boundarySeq) {
        throw new Error('Transcript page continuation skips returned boundary');
      }
    }

    return { messages, hasMore, nextBeforeSeq, nextAfterSeq };
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
