import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

const credentials: AuthCredentials = { token: 'test-token', secret: 'test-secret' };

describe('apiUsage server generation guard', () => {
    it.each([false, true])('retains the query Home across transient backoff (Home moved: %s)', async (changeHome) => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://api.example.test' });
        let observeIssued!: () => void;
        const issued = new Promise<void>((resolve) => { observeIssued = resolve; });
        let releaseFailure!: () => void;
        const failure = new Promise<void>((resolve) => { releaseFailure = resolve; });
        let failed = false;
        const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
            const url = new URL(String(input));
            if (url.pathname === '/v2/usage/query' && url.origin === 'https://api.example.test' && !failed) {
                failed = true;
                observeIssued();
                await failure;
                return Response.json({}, { status: 503 });
            }
            return Response.json({ usage: [] });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
        const { queryUsage } = await import('./apiUsage');
        const outcome = queryUsage(credentials, {}).then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason: unknown) => ({ status: 'rejected' as const, reason }),
        );
        await issued;
        vi.useFakeTimers();
        releaseFailure();
        // Drain the genuine failed transport attempt into the existing shared backoff.
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).pathname === '/v2/usage/query')).toBe(true);
        if (changeHome) await upsertAndActivateServer({ serverUrl: 'https://other.example.test' });
        // The shared backoff owner's existing maximum delay is one second.
        await vi.advanceTimersByTimeAsync(1_000);
        const settled = await outcome;
        expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).origin === 'https://other.example.test')).toBe(false);
        expect(settled).toMatchObject(changeHome
            ? { status: 'rejected', reason: { name: 'StaleServerGenerationError' } }
            : { status: 'fulfilled', value: { usage: [] } });
    });

    it('does not replay an aborted query with its captured bearer to a successor Home', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://api.example.test' });
        let observeIssued!: () => void;
        const issued = new Promise<void>((resolve) => { observeIssued = resolve; });
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = new URL(String(input));
            if (url.pathname !== '/v2/usage/query' || url.origin !== 'https://api.example.test') return Response.json({ usage: [] });
            return await new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                if (!signal) throw new Error('missing request cancellation signal');
                const rejectAborted = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                if (signal.aborted) rejectAborted();
                else signal.addEventListener('abort', rejectAborted, { once: true });
                observeIssued();
            });
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
        const { queryUsage } = await import('./apiUsage');
        const { abortServerFetches } = await import('@/sync/http/client');
        const pending = queryUsage(credentials, {});
        const outcome = pending.then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason: unknown) => ({ status: 'rejected' as const, reason }),
        );
        await issued;
        const initialQuery = fetchMock.mock.calls.find(([input]) => new URL(String(input)).pathname === '/v2/usage/query');
        expect(new Headers(initialQuery?.[1]?.headers).get('authorization')).toBe(`Bearer ${credentials.token}`);
        await upsertAndActivateServer({ serverUrl: 'https://other.example.test' });
        abortServerFetches();
        const settled = await outcome;
        expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).origin === 'https://other.example.test')).toBe(false);
        expect(settled).toMatchObject({ status: 'rejected', reason: { name: 'StaleServerGenerationError' } });
    });

    it('rejects stale queryUsage responses after active server generation changes', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://api.example.test' });

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (new URL(String(input)).pathname !== '/v2/usage/query') return Response.json({});
            await upsertAndActivateServer({ serverUrl: 'https://other.example.test' });
            return {
                ok: true,
                status: 200,
                json: async () => ({ usage: [] }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { queryUsage } = await import('./apiUsage');
        await expect(queryUsage(credentials, {})).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
        expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).origin === 'https://other.example.test')).toBe(false);
    });
});
