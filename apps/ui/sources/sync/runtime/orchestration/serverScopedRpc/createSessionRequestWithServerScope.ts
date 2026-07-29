import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import {
    areServerAccountScopesEqual,
    createServerAccountScope,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

import { resolveServerScopedSessionContext } from './resolveServerScopedSessionContext';
import type {
    ResolvedServerSessionRpcContext,
} from './resolveServerScopedSessionContext';

type ScopedServerSessionRpcContext = Extract<
    ResolvedServerSessionRpcContext,
    { scope: 'scoped' }
>;

export type ServerAccountSessionRequestAuthority = Readonly<{
    scope: ServerAccountScope;
    context: ScopedServerSessionRpcContext;
    request: (path: string, init?: RequestInit) => Promise<Response>;
}>;

export function createSessionRequestForResolvedServerScope(params: Readonly<{
    context: ResolvedServerSessionRpcContext;
    activeRequest: (path: string, init?: RequestInit) => Promise<Response>;
}>): (path: string, init?: RequestInit) => Promise<Response> {
    return async (path: string, init?: RequestInit) => {
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
}>): (path: string, init?: RequestInit) => Promise<Response> {
    return async (path: string, init?: RequestInit) => {
        const context = await resolveServerScopedSessionContext({ serverId: params.serverId ?? null });
        return await createSessionRequestForResolvedServerScope({
            context,
            activeRequest: params.activeRequest,
        })(path, init);
    };
}

export async function captureSessionRequestAuthorityForServerAccountScope(params: Readonly<{
    scope: ServerAccountScope;
    activeRequest: (path: string, init?: RequestInit) => Promise<Response>;
}>): Promise<ServerAccountSessionRequestAuthority> {
    const context = await resolveServerScopedSessionContext({
        serverId: params.scope.serverId,
        preferScoped: true,
    });
    if (context.scope !== 'scoped') {
        throw new Error('Account-scoped request did not resolve to scoped credentials');
    }
    const resolvedScope = createServerAccountScope(context.targetServerId, context.targetAccountId);
    if (!areServerAccountScopesEqual(resolvedScope, params.scope)) {
        throw new Error('Account-scoped request authenticated account does not match requested scope');
    }
    return {
        scope: params.scope,
        context,
        request: createSessionRequestForResolvedServerScope({
            context,
            activeRequest: params.activeRequest,
        }),
    };
}

export async function resolveSessionRequestForServerAccountScope(params: Readonly<{
    scope: ServerAccountScope;
    activeRequest: (path: string, init?: RequestInit) => Promise<Response>;
}>): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
    const authority = await captureSessionRequestAuthorityForServerAccountScope({
        scope: params.scope,
        activeRequest: params.activeRequest,
    });
    return authority.request;
}
