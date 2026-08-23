import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

async function loadClient(params?: Readonly<{
    response?: Response;
    retireBeforeRequest?: boolean;
    retireDuringRequest?: boolean;
}>) {
    let current = true;
    let generation = 1;
    const retireCallbacks = new Set<() => void>();
    const activeRequest = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
    const transport = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => {
        if (params?.retireDuringRequest) {
            current = false;
            for (const callback of [...retireCallbacks]) callback();
        }
        return params?.response ?? new Response(JSON.stringify({ status: 'signed_out' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    const lifetime = {
        scope: { serverId: 'server-a', accountId: 'account-a' },
        isCurrent: () => current,
        onRetire: (callback: () => void) => {
            retireCallbacks.add(callback);
            return { dispose: () => retireCallbacks.delete(callback) };
        },
    };
    const captureAuthority = vi.fn(async () => {
        if (params?.retireBeforeRequest) {
            current = false;
            for (const callback of [...retireCallbacks]) callback();
        }
        return { scope: lifetime.scope, context: {}, request: transport };
    });

    vi.doMock('@/sync/domains/scope/activeServerAccountScope', () => ({
        captureActiveServerAccountScopeLifetime: () => lifetime,
    }));
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({
            serverId: 'server-a',
            serverUrl: 'https://server.example',
            generation,
        }),
    }));
    vi.doMock('@/sync/api/session/apiSocket', () => ({
        apiSocket: { request: activeRequest },
    }));
    vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope', () => ({
        captureSessionRequestAuthorityForServerAccountScope: captureAuthority,
    }));

    const client = await import('./signOutEverywhere');
    return {
        ...client,
        activeRequest,
        captureAuthority,
        transport,
        advanceGeneration: () => { generation += 1; },
        retireScope: () => {
            current = false;
            for (const callback of [...retireCallbacks]) callback();
        },
    };
}

describe('signOutEverywhere', () => {
    it('uses the captured Account-scoped request authority and never sends an Account target', async () => {
        const client = await loadClient();

        await expect(client.signOutEverywhere({})).resolves.toEqual({ status: 'signed_out' });

        expect(client.captureAuthority).toHaveBeenCalledWith({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            activeRequest: expect.any(Function),
        });
        expect(client.activeRequest).not.toHaveBeenCalled();
        const [path, init] = client.transport.mock.calls[0]!;
        expect(path).toBe('/v1/auth/sessions/sign-out-everywhere');
        expect(JSON.parse(String(init?.body))).toEqual({});
        expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    });

    it('does not issue a request after the captured Account scope retires', async () => {
        const client = await loadClient({ retireBeforeRequest: true });

        await expect(client.signOutEverywhere({})).rejects.toThrow('account_sessions_sign_out_unavailable');

        expect(client.transport).not.toHaveBeenCalled();
    });

    it('aborts and drops a response after an Account switch', async () => {
        const client = await loadClient({ retireDuringRequest: true });

        await expect(client.signOutEverywhere({})).rejects.toThrow('account_sessions_sign_out_unavailable');

        const [, init] = client.transport.mock.calls[0]!;
        expect(init?.signal?.aborted).toBe(true);
    });

    it('does not start a request after host cancellation', async () => {
        const client = await loadClient();
        const controller = new AbortController();
        controller.abort();

        await expect(client.signOutEverywhere({}, { signal: controller.signal })).rejects.toThrow(
            'account_sessions_sign_out_unavailable',
        );

        expect(client.captureAuthority).not.toHaveBeenCalled();
        expect(client.transport).not.toHaveBeenCalled();
    });
});
