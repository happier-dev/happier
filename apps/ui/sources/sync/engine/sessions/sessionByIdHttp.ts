import type { SessionMessagesPageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import type { CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';
import { readSessionParts, SessionPartsHttpError, resetSessionPartsReadsForTests } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionBatchForAuthority';
import { readCredentialAuthorityKind } from '@/auth/context/credentialAuthority';
import type { ScopedBatchResolutionContext } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';

type SessionByIdRequest = (path: string, init: RequestInit) => Promise<Response>;
export type SessionByIdHttpRead = Readonly<{ ok: boolean; status: number; body: unknown;
  turns?: Readonly<{ status: number; body: unknown }>;
  initialMessagesPage?: SessionMessagesPageV1 }>;

export type SessionByIdHttpReadParams = Readonly<{
  sessionId: string;
  serverId?: string | null;
  token: string;
  request: SessionByIdRequest;
  readTransport?: CapturedServerReadTransport;
  timeoutMs?: number;
  accessProjectionVersion?: 1;
  projection?: 'detail' | 'turns' | 'snapshot';
  initialTranscript?: 'main';
  signal?: AbortSignal;
  retry?: 'none';
  fresh?: boolean;
  onBatch?: (chunk: ScopedBatchResolutionContext) => void;
}>;

/** Parsed transport observations only; callers retain access, crypto and publication admission. */
export async function readSessionByIdHttp(params: SessionByIdHttpReadParams): Promise<SessionByIdHttpRead> {
  const projection = params.projection ?? 'detail';
  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
    ? params.timeoutMs : null;
  const deadline = timeoutMs === null ? null : new AbortController();
  const timeoutId = deadline && timeoutMs !== null ? setTimeout(() => deadline.abort(), timeoutMs) : null;
  const cancellation = mergeAbortSignals([deadline?.signal, params.signal]);
  try {
    if (params.readTransport && readCredentialAuthorityKind(params.token) !== 'api_token') {
      try {
        const row = (await readSessionParts({ request: params.request, readTransport: params.readTransport,
          sessionIds: [params.sessionId], includeSnapshot: true, includeTurns: projection !== 'detail',
          includeMessages: false, initialTranscript: projection === 'snapshot' ? params.initialTranscript : undefined, accessProjectionVersion: params.accessProjectionVersion,
          signal: cancellation.signal, fresh: params.fresh, retry: params.retry, assertCurrent: () => {},
          onResult: (_id, _part, chunk) => params.onBatch?.(chunk) })).get(params.sessionId);
        const part = projection === 'turns' ? row?.turns ?? (row?.detail?.status !== 200 ? row?.detail : undefined) : row?.detail;
        if (!part) throw new Error('Incomplete Session parts response');
        return { ok: part.status === 200, status: part.status, body: part.body,
          ...(projection === 'snapshot' && row?.turns ? { turns: row.turns } : {}),
          ...(params.initialTranscript === 'main' && projection === 'snapshot' && row?.messages?.status === 200
            ? { initialMessagesPage: row.messages.body } : {}) };
      } catch (error) {
        if (error instanceof SessionPartsHttpError) return { ok: false, status: error.httpStatus, body: error.body };
        throw error;
      }
    }
    // Restricted/opaque requests do not establish a neutral Account carrier.
    // Their request owner already propagates cancellation to the physical carrier.
    throwIfAborted(cancellation.signal);
    const path = projection === 'turns' ? `/v1/sessions/${encodeURIComponent(params.sessionId)}/turns`
      : `/v2/sessions/${encodeURIComponent(params.sessionId)}${params.accessProjectionVersion === 1 ? '?accessProjectionVersion=1' : ''}`;
    const response = await params.request(path, { method: 'GET',
      headers: { Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' }, signal: cancellation.signal });
    const body = await response.json().catch(() => null);
    throwIfAborted(cancellation.signal);
    return { ok: response.ok, status: response.status, body };
  } finally {
    cancellation.dispose();
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

export function resetSessionByIdHttpReadsForTests(): void { resetSessionPartsReadsForTests(); }
