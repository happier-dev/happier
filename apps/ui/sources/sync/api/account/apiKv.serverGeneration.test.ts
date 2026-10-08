import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

const credentials: AuthCredentials = { token: 'test-token', secret: 'test-secret' };

describe('apiKv server generation guard', () => {
    it('does not replay a mutation with captured credentials after Home changes during backoff', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://api.example.test' });
        let observeIssued!: () => void;
        const issued = new Promise<void>((resolve) => { observeIssued = resolve; });
        let releaseFailure!: () => void;
        const failure = new Promise<void>((resolve) => { releaseFailure = resolve; });
        const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
            const url = new URL(String(input));
            if (url.pathname !== '/v1/kv') return Response.json({});
            if (url.origin === 'https://api.example.test') {
                observeIssued();
                await failure;
                return Response.json({}, { status: 503 });
            }
            return Response.json({ success: true, results: [{ key: 'k', version: 1 }] });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
        const { kvMutate } = await import('./apiKv');
        const mutations = [{ key: 'k', value: 'v', version: -1 }];
        const outcome = kvMutate(credentials, mutations).then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason: unknown) => ({ status: 'rejected' as const, reason }),
        );
        await issued;
        vi.useFakeTimers();
        releaseFailure();
        await vi.advanceTimersByTimeAsync(0);
        const initial = fetchMock.mock.calls.find(([input]) => new URL(String(input)).pathname === '/v1/kv');
        expect(initial).toBeDefined();
        expect(new Headers(initial?.[1]?.headers).get('authorization')).toBe(`Bearer ${credentials.token}`);
        expect(JSON.parse(String(initial?.[1]?.body))).toEqual({ mutations });
        await upsertAndActivateServer({ serverUrl: 'https://other.example.test' });
        await vi.advanceTimersByTimeAsync(1_000);
        const settled = await outcome;
        expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).origin === 'https://other.example.test')).toBe(false);
        expect(settled).toMatchObject({ status: 'rejected', reason: { name: 'StaleServerGenerationError' } });
    });

    it('rejects stale kvGet responses after active server generation changes', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://api.example.test' });

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (new URL(String(input)).pathname !== '/v1/kv/k') return Response.json({});
            await upsertAndActivateServer({ serverUrl: 'https://other.example.test' });
            return {
                ok: true,
                status: 200,
                json: async () => ({ key: 'k', value: 'v', version: 1 }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { kvGet } = await import('./apiKv');
        await expect(kvGet(credentials, 'k')).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
    });
});
