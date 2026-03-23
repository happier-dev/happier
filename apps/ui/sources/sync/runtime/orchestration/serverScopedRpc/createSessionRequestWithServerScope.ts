import { runtimeFetch } from '@/utils/system/runtimeFetch';

import { resolveServerScopedSessionContext } from './resolveServerScopedSessionContext';

export function createSessionRequestWithServerScope(params: Readonly<{
    serverId?: string | null;
    activeRequest: (path: string, init?: RequestInit) => Promise<Response>;
}>): (path: string, init?: RequestInit) => Promise<Response> {
    return async (path: string, init?: RequestInit) => {
        const context = await resolveServerScopedSessionContext({ serverId: params.serverId ?? null });
        if (context.scope === 'active') {
            return await params.activeRequest(path, init);
        }

        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${context.token}`);
        return await runtimeFetch(`${context.targetServerUrl}${path}`, {
            ...init,
            method: init?.method ?? 'GET',
            headers,
        });
    };
}
