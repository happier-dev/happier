import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import {
    resetServerReachabilitySupervisors,
    startServerReachabilitySupervisor,
    subscribeServerReachabilityState,
} from './serverReachabilitySupervisorPool';

afterEach(async () => {
    resetRuntimeFetch();
    await resetServerReachabilitySupervisors();
    vi.useRealTimers();
});

type ObservedState = {
    phase: string | null;
    reason: string | null;
    nextRetryAt: number | null;
};

async function runProbe(params: Readonly<{
    token: string | null;
    respond: (url: string) => Response;
}>): Promise<{ observed: ObservedState; requestedUrls: string[] }> {
    const runtimeFetchSpy = vi.fn(async (input: RequestInfo | URL) => params.respond(String(input)));
    setRuntimeFetch(runtimeFetchSpy);

    const observed: ObservedState = { phase: null, reason: null, nextRetryAt: null };
    const unsubscribe = subscribeServerReachabilityState('https://example.test', (state) => {
        observed.phase = state.phase;
        observed.reason = state.reason;
        observed.nextRetryAt = state.nextRetryAt;
    });

    try {
        await startServerReachabilitySupervisor({
            serverUrl: 'https://example.test',
            token: params.token,
        });
    } finally {
        unsubscribe();
    }

    return { observed, requestedUrls: runtimeFetchSpy.mock.calls.map(([input]) => String(input)) };
}

describe('serverReachabilitySupervisorPool (readiness probe)', () => {
    it('issues only the authenticated ping when a token is available', async () => {
        vi.useFakeTimers();

        const { observed, requestedUrls } = await runProbe({
            token: 'token',
            respond: (url) => {
                if (url.endsWith('/v1/auth/ping')) {
                    return new Response(JSON.stringify({ ok: true }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                throw new Error(`Unexpected probe URL: ${url}`);
            },
        });

        expect(observed.phase).toBe('online');
        expect(requestedUrls).toEqual(['https://example.test/v1/auth/ping']);
    });

    it('treats a host that does not serve the authenticated ping as unreachable (prevents wrong-server loops)', async () => {
        vi.useFakeTimers();

        const { observed, requestedUrls } = await runProbe({
            token: 'token',
            respond: (url) => {
                if (url.endsWith('/v1/auth/ping')) {
                    return new Response('nope', { status: 404, headers: { 'Content-Type': 'text/plain' } });
                }
                throw new Error(`Unexpected probe URL: ${url}`);
            },
        });

        expect(observed.phase).toBe('offline');
        expect(observed.reason).toBe('server_unreachable');
        expect(requestedUrls).toEqual(['https://example.test/v1/auth/ping']);
    });

    it('treats a 429 authenticated ping as retry_later (respects Retry-After)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);

        const { observed, requestedUrls } = await runProbe({
            token: 'token',
            respond: (url) => {
                if (url.endsWith('/v1/auth/ping')) {
                    return new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } });
                }
                throw new Error(`Unexpected probe URL: ${url}`);
            },
        });

        expect(observed.phase).toBe('offline');
        expect(observed.reason).toBe('probe_failed');
        expect(observed.nextRetryAt).toBe(1000);
        expect(requestedUrls).toEqual(['https://example.test/v1/auth/ping']);
    });

    it('preserves planned restart reason from authenticated ping retry-later responses', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);

        const { observed, requestedUrls } = await runProbe({
            token: 'token',
            respond: (url) => {
                if (url.endsWith('/v1/auth/ping')) {
                    return new Response('Server reload in progress', {
                        status: 503,
                        headers: { 'Retry-After': '2', 'X-Happier-Retry-Reason': 'server_restarting' },
                    });
                }
                throw new Error(`Unexpected probe URL: ${url}`);
            },
        });

        expect(observed.phase).toBe('offline');
        expect(observed.reason).toBe('server_restarting');
        expect(observed.nextRetryAt).toBe(2000);
        expect(requestedUrls).toEqual(['https://example.test/v1/auth/ping']);
    });

    it('falls back to the unauthenticated health check when there is no token', async () => {
        vi.useFakeTimers();

        const { observed, requestedUrls } = await runProbe({
            token: null,
            respond: (url) => {
                if (url.endsWith('/health')) {
                    return new Response(JSON.stringify({ ok: true }), { status: 200 });
                }
                throw new Error(`Unexpected probe URL: ${url}`);
            },
        });

        expect(observed.phase).toBe('online');
        expect(requestedUrls).toEqual(['https://example.test/health']);
    });

    it('preserves planned restart reason from proxy maintenance health responses (tokenless)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);

        const { observed, requestedUrls } = await runProbe({
            token: null,
            respond: (url) => {
                if (url.endsWith('/health')) {
                    return new Response('Server reload in progress', {
                        status: 503,
                        headers: { 'Retry-After': '2', 'X-Happier-Retry-Reason': 'server_restarting' },
                    });
                }
                throw new Error(`Unexpected probe URL: ${url}`);
            },
        });

        expect(observed.phase).toBe('offline');
        expect(observed.reason).toBe('server_restarting');
        expect(observed.nextRetryAt).toBe(2000);
        expect(requestedUrls).toEqual(['https://example.test/health']);
    });
});
