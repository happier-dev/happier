import { afterEach, describe, expect, it, vi } from 'vitest';

const token = {
    tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d',
    label: 'CI deploy',
    displayPrefix: 'hap_v1_dd03e74b',
    createdAt: '2026-08-22T12:00:00.000Z',
    lastUsedAt: null,
    expiresAt: '2026-11-20T12:00:00.000Z',
} as const;

const created = {
    token: `hap_v1_${token.tokenId}_${'A'.repeat(43)}`,
    apiToken: token,
} as const;

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

async function loadClient(params?: Readonly<{
    retireBeforeRequest?: boolean;
    responseForPath?: (path: string) => unknown;
    throwForPath?: (path: string) => unknown;
}>) {
    let current = true;
    let generation = 1;
    const retireCallbacks = new Set<() => void>();
    const transport = vi.fn(async (path: string, _init?: RequestInit) => {
        const thrown = params?.throwForPath?.(path);
        if (thrown !== undefined) throw thrown;
        const body = params?.responseForPath?.(path) ?? (
            path.endsWith('/create') ? created
                : path.endsWith('/list') ? { tokens: [token] }
                    : path.endsWith('/revoke-all') ? { revokedCount: 1 }
                        : { revoked: true }
        );
        return new Response(JSON.stringify(body), {
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
        apiSocket: { request: vi.fn() },
    }));
    vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope', () => ({
        captureSessionRequestAuthorityForServerAccountScope: captureAuthority,
    }));

    const client = await import('./apiTokens');
    return {
        ...client,
        transport,
        captureAuthority,
        retireScope: () => {
            current = false;
            for (const callback of [...retireCallbacks]) callback();
        },
        advanceGeneration: () => { generation += 1; },
    };
}

describe('current-Account API-token Action transport', () => {
    it('maps all four Action inputs to their scoped routes without an Account selector and preserves the one-time create bearer only in its result', async () => {
        const client = await loadClient();

        await expect(client.createCurrentAccountApiToken({ label: token.label, expiresAt: token.expiresAt }))
            .resolves.toEqual(created);
        await expect(client.listCurrentAccountApiTokens({})).resolves.toEqual({ tokens: [token] });
        await expect(client.revokeCurrentAccountApiToken({ tokenId: token.tokenId })).resolves.toEqual({ revoked: true });
        await expect(client.revokeAllCurrentAccountApiTokens({})).resolves.toEqual({ revokedCount: 1 });

        expect(client.captureAuthority).toHaveBeenCalledTimes(4);
        expect(client.transport.mock.calls.map(([path]) => path)).toEqual([
            '/v1/auth/api-tokens/create',
            '/v1/auth/api-tokens/list',
            '/v1/auth/api-tokens/revoke',
            '/v1/auth/api-tokens/revoke-all',
        ]);
        expect(client.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
            { label: token.label, expiresAt: token.expiresAt },
            {},
            { tokenId: token.tokenId },
            {},
        ]);
    });

    it('drops stale/currentness-invalid responses and rejects a list response that attempts to disclose a bearer', async () => {
        const retired = await loadClient({ retireBeforeRequest: true });
        await expect(retired.listCurrentAccountApiTokens({})).rejects.toThrow('account_api_tokens_unavailable');
        expect(retired.transport).not.toHaveBeenCalled();

        const malformed = await loadClient({
            responseForPath: (path) => path.endsWith('/list')
                ? { tokens: [{ ...token, token: created.token }] }
                : { tokens: [token] },
        });
        await expect(malformed.listCurrentAccountApiTokens({})).rejects.toThrow('account_api_tokens_unavailable');
    });

    it('returns a typed network failure so the Action boundary can preserve the designed offline retry state', async () => {
        const client = await loadClient({
            throwForPath: (path) => path.endsWith('/list') ? new Error('network down') : undefined,
        });

        await expect(client.listCurrentAccountApiTokens({})).resolves.toEqual({
            ok: false,
            errorCode: 'network_error',
            error: 'network_error',
        });
    });
});
