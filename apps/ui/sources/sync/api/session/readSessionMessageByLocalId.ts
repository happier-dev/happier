import type { ServerAccountRequestOptions } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';

/** The existing exact transcript message read. The caller owns its response projection. */
export function readSessionMessageByLocalId(
    request: (path: string, init?: RequestInit, options?: ServerAccountRequestOptions) => Promise<Response>,
    sessionId: string,
    localId: string,
    signal?: AbortSignal,
) {
    return request(`/v2/sessions/${encodeURIComponent(sessionId)}/messages/by-local-id/${encodeURIComponent(localId)}`,
        { method: 'GET', signal }, { retry: 'none' });
}
