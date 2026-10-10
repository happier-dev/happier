import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import {
    acquireServerReachabilitySupervisor,
    peekServerReachabilityState,
    resetServerReachabilitySupervisors,
    startServerReachabilitySupervisor,
    stopServerReachabilitySupervisor,
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
    runtimeOrigin?: string;
    respond: (url: string) => Response;
}>): Promise<{ observed: ObservedState; requestedUrls: string[] }> {
    const runtimeFetchSpy = vi.fn(async (input: RequestInfo | URL) => params.respond(String(input)));
    setRuntimeFetch(runtimeFetchSpy);

    const observed: ObservedState = { phase: null, reason: null, nextRetryAt: null };
    const unsubscribe = subscribeServerReachabilityState('https://example.test', (state) => {
        observed.phase = state.phase;
        observed.reason = state.reason;
        observed.nextRetryAt = state.nextRetryAt;
    }, params.token);

    try {
        await startServerReachabilitySupervisor({
            serverUrl: 'https://example.test',
            token: params.token,
            ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
        });
    } finally {
        unsubscribe();
    }

    return { observed, requestedUrls: runtimeFetchSpy.mock.calls.map(([input]) => String(input)) };
}

describe('serverReachabilitySupervisorPool (readiness probe)', () => {
    it('isolates authenticated readiness for different credentials at the same canonical URL', async () => {
        vi.useFakeTimers();
        setRuntimeFetch(vi.fn(async (_input, init) => {
            const authorization = new Headers(init?.headers).get('Authorization');
            if (authorization === 'Bearer rejected-token') {
                return new Response(null, { status: 401, headers: new Headers() });
            }
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }));

        await startServerReachabilitySupervisor({
            serverUrl: 'https://example.test',
            token: 'accepted-token',
        });
        await startServerReachabilitySupervisor({
            serverUrl: 'https://example.test',
            token: 'rejected-token',
        });

        expect(peekServerReachabilityState('https://example.test', 'accepted-token')?.phase).toBe('online');
        expect(peekServerReachabilityState('https://example.test', 'rejected-token')?.phase).toBe('auth_failed');
    });

    it('hands one canonical supervisor between retained consumers and stops only after the final release', async () => {
        vi.useFakeTimers();
        setRuntimeFetch(vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })));

        const first = await acquireServerReachabilitySupervisor({
            serverUrl: 'https://example.test',
            runtimeOrigin: 'http://127.0.0.1:45981',
            token: 'token',
        });
        const second = await acquireServerReachabilitySupervisor({
            serverUrl: 'https://example.test',
            runtimeOrigin: 'http://127.0.0.1:45981',
            token: 'token',
        });
        expect(peekServerReachabilityState('https://example.test', 'token')?.phase).toBe('online');

        await first.release();
        expect(peekServerReachabilityState('https://example.test', 'token')?.phase).toBe('online');

        await second.release();
        expect(peekServerReachabilityState('https://example.test', 'token')?.phase).not.toBe('online');
    });

    it('keeps the exact scoped entry when it is reacquired while final release is stopping it', async () => {
        setRuntimeFetch(vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })));

        const first = await acquireServerReachabilitySupervisor({
            serverUrl: 'https://example.test',
            token: 'token',
        });
        const finalRelease = first.release();
        const second = await acquireServerReachabilitySupervisor({
            serverUrl: 'https://example.test',
            token: 'token',
        });
        await finalRelease;

        expect(peekServerReachabilityState('https://example.test', 'token')?.phase).toBe('online');

        await second.release();
    });

    it('keeps the exact scoped entry when a subscriber arrives while final release is stopping it', async () => {
        setRuntimeFetch(vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })));

        const first = await acquireServerReachabilitySupervisor({
            serverUrl: 'https://example.test',
            token: 'token',
        });
        const finalRelease = first.release();
        const unsubscribe = subscribeServerReachabilityState('https://example.test', () => {}, 'token');
        await finalRelease;

        expect(peekServerReachabilityState('https://example.test', 'token')?.phase).toBe('online');

        unsubscribe();
        await stopServerReachabilitySupervisor('https://example.test', 'token');
    });

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

    it('keeps canonical reachability ownership while probing an acquired runtime origin', async () => {
        vi.useFakeTimers();

        const { observed, requestedUrls } = await runProbe({
            token: 'token',
            runtimeOrigin: 'http://127.0.0.1:45981',
            respond: (url) => {
                if (url === 'http://127.0.0.1:45981/v1/auth/ping') {
                    return new Response(JSON.stringify({ ok: true }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                throw new Error(`Unexpected probe URL: ${url}`);
            },
        });

        expect(observed.phase).toBe('online');
        expect(requestedUrls).toEqual(['http://127.0.0.1:45981/v1/auth/ping']);
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

    it.each([401, 403])('does not label an authentication-protected /health as an unreachable Home (%i)', async status => {
        const { observed } = await runProbe({ token: null, respond: () => new Response(null, { status }) });
        expect(observed.phase).toBe('online');
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
