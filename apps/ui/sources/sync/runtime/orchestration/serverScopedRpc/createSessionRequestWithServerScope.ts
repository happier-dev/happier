import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import type { ServerReadRequestInit } from '@/sync/http/client';
import {
    areServerAccountScopesEqual,
    createServerAccountScope,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

import { resolveServerScopedSessionContext } from './resolveServerScopedSessionContext';
import type { ResolvedServerSessionRpcContext } from './resolveServerScopedSessionContext';

export function createSessionRequestForResolvedServerScope(params: Readonly<{
    context: ResolvedServerSessionRpcContext;
    activeRequest: (path: string, init?: RequestInit) => Promise<Response>;
}>): (path: string, init?: ServerReadRequestInit) => Promise<Response> {
    return async (path: string, init?: ServerReadRequestInit) => {
        if (params.context.scope === 'active') {
            return await params.activeRequest(path, init);
        }

        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${params.context.token}`);
        return await runtimeFetchWithServerReachability({
            serverUrl: params.context.targetServerUrl,
            token: params.context.token,
            url: `${params.context.targetServerUrl}${path}`,
            init: {
                ...init,
                method: init?.method ?? 'GET',
                headers,
            },
        });
    };
}

export function createSessionRequestWithServerScope(params: Readonly<{
    serverId?: string | null;
    activeRequest: (path: string, init?: RequestInit) => Promise<Response>;
}>): (path: string, init?: ServerReadRequestInit) => Promise<Response> {
    return async (path: string, init?: ServerReadRequestInit) => {
        const context = await resolveServerScopedSessionContext({ serverId: params.serverId ?? null });
        return await createSessionRequestForResolvedServerScope({
            context,
            activeRequest: params.activeRequest,
        })(path, init);
    };
}

export async function resolveSessionRequestForServerAccountScope(params: Readonly<{
    scope: ServerAccountScope;
    activeRequest: (path: string, init?: RequestInit) => Promise<Response>;
}>): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
    const context = await resolveServerScopedSessionContext({
        serverId: params.scope.serverId,
        preferScoped: true,
    });
    if (context.scope !== 'scoped') {
        throw new Error('Pending outbox scope did not resolve to scoped credentials');
    }
    const resolvedScope = createServerAccountScope(context.targetServerId, context.targetAccountId);
    if (!areServerAccountScopesEqual(resolvedScope, params.scope)) {
        throw new Error('Pending outbox authenticated account does not match persisted scope');
    }
    return createSessionRequestForResolvedServerScope({
        context,
        activeRequest: params.activeRequest,
    });
}
