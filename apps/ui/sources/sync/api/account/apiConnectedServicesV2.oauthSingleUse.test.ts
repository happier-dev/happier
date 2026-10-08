import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'single-use', serverUrl: 'https://api.example.test', kind: 'custom', generation: 1 }),
}));

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('OAuth authorization-code single-use transport', () => {
    it.each(['network', '408', '429', '503'] as const)('does not replay an authorization code after a %s failure', async (failure) => {
        const { exchangeConnectedServiceOauthViaProxy } = await import('./apiConnectedServicesV2');
        vi.useFakeTimers();
        let exchanges = 0;
        vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
            if (!String(input).includes('/oauth/exchange')) return Response.json({ ok: true });
            exchanges += 1;
            if (exchanges > 1) return Response.json({ bundle: 'replayed-code' });
            if (failure === 'network') throw new TypeError('Network unavailable');
            return Response.json({}, { status: Number(failure) });
        }));
        let outcome: 'pending' | 'failed' | 'succeeded' = 'pending';
        const request = exchangeConnectedServiceOauthViaProxy({ token: 't', secret: 's' }, {
            serviceId: 'antigravity', publicKey: 'public', code: 'one-use', verifier: 'verifier',
            redirectUri: 'http://localhost:54545/', state: 'state',
        }).then(() => { outcome = 'succeeded'; }, () => { outcome = 'failed'; });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(outcome).toBe('failed');
        expect(exchanges).toBe(1);
        await request;
    });
});
