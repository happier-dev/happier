import type { SessionMessageRole } from '@happier-dev/protocol';

import type { ApiSessionMessagesResponse } from '@/sync/api/types/apiTypes';
import { ApiSessionMessagesResponseSchema } from '@/sync/api/types/apiTypes';

export type SessionMessagesPageScope = 'main' | 'sidechain' | 'all';

export type BuildSessionMessagesPathParams = Readonly<{
    sessionId: string;
    scope: SessionMessagesPageScope;
    sidechainId?: string | null;
    limit?: number;
    beforeSeq?: number;
    afterSeq?: number;
    /**
     * Single-role filter understood by every released server. Callers that also pass `roles`
     * send both so a server without multi-role support degrades to this narrower filter
     * instead of rejecting the request.
     */
    role?: SessionMessageRole;
    /** Multi-role filter; ignored by servers that predate it. */
    roles?: readonly SessionMessageRole[];
}>;

function appendFiniteInteger(params: URLSearchParams, key: string, value: number | undefined): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    params.set(key, String(Math.trunc(value)));
}

export function buildSessionMessagesPath(params: BuildSessionMessagesPathParams): string {
    const query = new URLSearchParams({ scope: params.scope });
    if (params.role) {
        query.set('role', params.role);
    }
    if (params.roles && params.roles.length > 0) {
        query.set('roles', params.roles.join(','));
    }
    appendFiniteInteger(query, 'limit', params.limit);
    appendFiniteInteger(query, 'beforeSeq', params.beforeSeq);
    appendFiniteInteger(query, 'afterSeq', params.afterSeq);

    const sidechainId = typeof params.sidechainId === 'string' && params.sidechainId.trim().length > 0
        ? params.sidechainId.trim()
        : null;
    if (params.scope === 'sidechain' && sidechainId) {
        query.set('sidechainId', sidechainId);
    }

    return `/v1/sessions/${encodeURIComponent(params.sessionId)}/messages?${query.toString()}`;
}

export function parseSessionMessagesResponseJson(json: unknown): ApiSessionMessagesResponse {
    const parsed = ApiSessionMessagesResponseSchema.safeParse(json);
    if (!parsed.success) {
        throw new Error(`Invalid /messages response: ${parsed.error.message}`);
    }
    return parsed.data;
}

export async function fetchSessionMessagesPage(params: Readonly<{
    request: (path: string) => Promise<Response>;
    path: string;
}>): Promise<ApiSessionMessagesResponse> {
    const response = await params.request(params.path);
    return parseSessionMessagesResponseJson(await response.json());
}
