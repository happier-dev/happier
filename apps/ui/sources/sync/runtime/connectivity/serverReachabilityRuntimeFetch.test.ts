import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';

afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS;
    try {
        const { resetServerReachabilitySupervisors } = await import('./serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
    } catch {
        // ignore
    }
    vi.resetModules();
    vi.clearAllMocks();
});

describe('runtimeFetchWithServerReachability', () => {
    it.each([403, 500, 503])('keeps HTTP %s local to the resource while unrelated operations remain admissible', async (status) => {
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: async (input: RequestInfo | URL) => new Response('{}', {
                status: new URL(String(input)).pathname === '/resource' ? status : 200,
            }),
        }));
        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        const { peekServerReachabilityState } = await import('./serverReachabilitySupervisorPool');
        const target = { serverUrl: 'https://resource.example.test', token: 'accepted-token' };
        expect((await runtimeFetchWithServerReachability({ ...target, url: `${target.serverUrl}/resource`, init: { method: 'GET' } })).status).toBe(status);
        expect(peekServerReachabilityState(target.serverUrl)?.phase).toBe('online');
        expect((await runtimeFetchWithServerReachability({ ...target, url: `${target.serverUrl}/unrelated`, init: { method: 'POST' } })).ok).toBe(true);
    });

    it.each([false, true])('reports maintenance only in the request scope captured before dispatch (stale=%s)', async (stale) => {
        let respond!: (response: Response) => void;
        let dispatched!: () => void;
        const entered = new Promise<void>((resolve) => { dispatched = resolve; });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: async (input: RequestInfo | URL) => {
                if (new URL(String(input)).pathname !== '/maintenance') return new Response('{}', { status: 200 });
                dispatched();
                return await new Promise<Response>((resolve) => { respond = resolve; });
            },
        }));
        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        const { invalidateServerReachabilitySupervisor, peekServerReachabilityState } = await import('./serverReachabilitySupervisorPool');
        const target = { serverUrl: 'https://maintenance.example.test', token: 'accepted-token' };
        const pending = runtimeFetchWithServerReachability({ ...target, url: `${target.serverUrl}/maintenance`, init: { method: 'GET' } });
        await entered;
        if (stale) await invalidateServerReachabilitySupervisor(target);
        respond(new Response(null, { status: 503, headers: { 'Retry-After': '2', 'X-Happier-Retry-Reason': 'server_restarting' } }));
        expect((await pending).status).toBe(503);
        expect(peekServerReachabilityState(target.serverUrl)?.phase).toBe(stale ? 'online' : 'offline');
    });

    it('reports an unreachable server as a known network error before issuing the request', async () => {
        vi.useFakeTimers();
        const runtimeFetchMock = vi.fn(async (_input: RequestInfo | URL) => {
            throw new TypeError('Failed to fetch');
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));
        try {
            const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
            const { ServerReachabilityWaitTimeoutError } = await import('./serverReachabilitySupervisorPool');
            const { HappyError } = await import('@/utils/errors/errors');
            const { t } = await import('@/text');
            const promise = runtimeFetchWithServerReachability({
                serverUrl: 'https://api.example.test',
                token: 'token-a',
                url: 'https://api.example.test/v2/session-organization/folders',
                timeoutMs: 5,
                init: { method: 'POST' },
            });
            const assertion = expect(promise).rejects.toMatchObject({
                name: 'ServerReachabilityWaitTimeoutError',
                kind: 'network',
                canTryAgain: true,
                message: t('errors.connectionTimeout'),
            });
            await Promise.all([assertion, vi.advanceTimersByTimeAsync(5)]);
            await expect(promise).rejects.toBeInstanceOf(HappyError);
            await expect(promise).rejects.toBeInstanceOf(ServerReachabilityWaitTimeoutError);
            expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).includes('/folders'))).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([undefined, 'background-task'] as const)('refuses authenticated cross-origin requests in %s mode (prevents token leakage)', async (networkMode) => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        const runtimeFetchMock = vi.fn(async () => {
            throw new Error('Unexpected runtimeFetch call');
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        await expect(
            runtimeFetchWithServerReachability({
                serverUrl: 'https://api.example.test',
                token: 'token-a',
                url: 'https://other.example.test/v1/account/profile',
                networkMode,
                init: {
                    method: 'GET',
                    headers: {
                        Authorization: 'Bearer token-a',
                    },
                },
            }),
        ).rejects.toThrow('Refused authenticated request');

        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it.each([undefined, 'background-task'] as const)('redacts URLs in authenticated request errors in %s mode (prevents query-string leakage)', async (networkMode) => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        const runtimeFetchMock = vi.fn(async () => {
            throw new Error('Unexpected runtimeFetch call');
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const secret = 'super-secret-token';

        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        let thrown: unknown = null;
        try {
            await runtimeFetchWithServerReachability({
                serverUrl: `file:///tmp/server?token=${secret}`,
                token: 'token-a',
                url: `file:///tmp/target?token=${secret}`,
                networkMode,
                init: { method: 'GET' },
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain('Refused authenticated request');
        expect((thrown as Error).message).not.toContain(secret);

        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('returns the response once reachability is online', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '50';

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (new URL(url).pathname === '/v1/account/profile') {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        const response = await runtimeFetchWithServerReachability({
            serverUrl: 'https://api.example.test',
            token: 'token-a',
            url: 'https://api.example.test/v1/account/profile',
            init: {
                method: 'GET',
                headers: {
                    Authorization: 'Bearer token-a',
                },
            },
        });

        expect(response.ok).toBe(true);
        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).endsWith('/v1/auth/ping'))).toBe(true);
        const profileCall = runtimeFetchMock.mock.calls.find(([input]) => new URL(String(input)).pathname === '/v1/account/profile');
        expect(profileCall).toBeDefined();
        expect(JSON.parse(new URL(String(profileCall?.[0])).searchParams.get('happierConnectedServices') ?? 'null')).toEqual(ConnectedServiceIdSchema.options);
        const profileHeaders = new Headers(profileCall?.[1]?.headers);
        expect(profileHeaders.get('x-happier-session-sync-protocol')).toBeNull();
    });

    it('uses the Bearer token from Authorization header for reachability probing when token param is null', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '50';

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (url.endsWith('/v1/auth/ping')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (new URL(url).pathname === '/v1/account/profile') {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        const response = await runtimeFetchWithServerReachability({
            serverUrl: 'https://api.example.test',
            token: null,
            url: 'https://api.example.test/v1/account/profile',
            init: {
                method: 'GET',
                headers: {
                    Authorization: 'Bearer token-a',
                },
            },
        });

        expect(response.ok).toBe(true);
        // The probe only reaches the authenticated route when a token was resolved — here from the
        // Authorization header — and the unauthenticated health check is skipped once one exists.
        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).endsWith('/v1/auth/ping'))).toBe(true);
        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).endsWith('/health'))).toBe(false);
    });

    it.each([undefined, 'background-task'] as const)('marks an online server offline when the main request fails in %s mode', async (networkMode) => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '50';

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (new URL(url).pathname === '/v1/account/profile') {
                throw new TypeError('Network request failed');
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        // Background tasks do not create foreground supervisors. Establish one through
        // a normal request so both modes exercise an existing online connection.
        await runtimeFetchWithServerReachability({
            serverUrl: 'https://api.example.test',
            token: 'token-a',
            url: 'https://api.example.test/v1/sessions',
            init: { method: 'GET' },
        });
        await expect(
            runtimeFetchWithServerReachability({
                serverUrl: 'https://api.example.test',
                token: 'token-a',
                url: 'https://api.example.test/v1/account/profile',
                networkMode,
                init: {
                    method: 'GET',
                    headers: {
                        Authorization: 'Bearer token-a',
                    },
                },
            }),
        ).rejects.toThrow('Network request failed');

        const { subscribeServerReachabilityState } = await import('./serverReachabilitySupervisorPool');
        let latestPhase: string | null = null;
        const unsubscribe = subscribeServerReachabilityState('https://api.example.test', (state) => {
            latestPhase = state.phase;
        });
        unsubscribe();

        expect(latestPhase).toBe('offline');
    });

    it.each([
        { networkMode: undefined, signalOwner: 'request' },
        { networkMode: undefined, signalOwner: 'caller' },
        { networkMode: 'background-task', signalOwner: 'request' },
        { networkMode: 'background-task', signalOwner: 'caller' },
    ] as const)('does not report intentional cancellation as offline in $networkMode mode ($signalOwner signal)', async ({ networkMode, signalOwner }) => {
        const controller = new AbortController();
        const cancellation = new DOMException('Request cancelled', 'AbortError');
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: vi.fn(async (input: RequestInfo | URL) => {
                if (new URL(String(input)).pathname === '/v1/sessions') {
                    controller.abort();
                    throw cancellation;
                }
                return new Response(null, { status: 200 });
            }),
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        const target = { serverUrl: 'https://api.example.test', token: 'token-a' };
        // Establish real online reachability through the network boundary first.
        await runtimeFetchWithServerReachability({
            ...target,
            url: `${target.serverUrl}/v1/account/profile`,
            init: { method: 'GET' },
        });
        const { subscribeServerReachabilityState } = await import('./serverReachabilitySupervisorPool');
        let latestPhase: string | null = null;
        const unsubscribe = subscribeServerReachabilityState(target.serverUrl, (state) => {
            latestPhase = state.phase;
        });
        try {
            expect(latestPhase).toBe('online');
            await expect(runtimeFetchWithServerReachability({
                ...target,
                url: `${target.serverUrl}/v1/sessions`,
                networkMode,
                signal: signalOwner === 'caller' ? controller.signal : undefined,
                init: { method: 'GET', signal: signalOwner === 'request' ? controller.signal : undefined },
            })).rejects.toMatchObject({ name: 'AbortError' });
            expect(latestPhase).toBe('online');
        } finally {
            unsubscribe();
        }
    });

    it('marks the server auth_failed when an authenticated main request returns 401', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '50';

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (url.endsWith('/v1/auth/ping')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (new URL(url).pathname === '/v1/account/profile') {
                return new Response(null, { status: 401, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        const response = await runtimeFetchWithServerReachability({
            serverUrl: 'https://api.example.test',
            token: 'token-a',
            url: 'https://api.example.test/v1/account/profile',
            init: {
                method: 'GET',
                headers: {
                    Authorization: 'Bearer token-a',
                },
            },
        });

        expect(response.status).toBe(401);

        const { subscribeServerReachabilityState } = await import('./serverReachabilitySupervisorPool');
        let latestPhase: string | null = null;
        const unsubscribe = subscribeServerReachabilityState('https://api.example.test', (state) => {
            latestPhase = state.phase;
        });
        unsubscribe();

        expect(latestPhase).toBe('auth_failed');
    });

    it('rejects authenticated requests when the request URL origin differs from the serverUrl origin', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '50';

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (url.endsWith('/v1/auth/ping')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (new URL(url).pathname === '/v1/account/profile') {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        await expect(
            runtimeFetchWithServerReachability({
                serverUrl: 'https://api.example.test',
                token: 'token-a',
                url: 'https://other.example.test/v1/account/profile',
                init: {
                    method: 'GET',
                    headers: {
                        Authorization: 'Bearer token-a',
                    },
                },
            }),
        ).rejects.toThrow(/refused authenticated request/i);
    });

    it('rejects authenticated requests when the request URL is not a valid absolute URL', async () => {
        const runtimeFetchMock = vi.fn(async () => {
            throw new Error('runtimeFetch should not be called');
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { runtimeFetchWithServerReachability } = await import('./serverReachabilityRuntimeFetch');
        const thrown = await runtimeFetchWithServerReachability({
            serverUrl: 'https://admin:secret@example.com:8443/path?token=abc#frag',
            token: 'token-a',
            url: 'https://[::1',
            init: {
                method: 'GET',
                headers: {
                    Authorization: 'Bearer token-a',
                },
            },
        }).catch((error) => error);

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toMatch(/refused authenticated request/i);
        expect((thrown as Error).message).not.toContain('admin:secret');
        expect((thrown as Error).message).not.toContain('token=abc');

        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });
});
