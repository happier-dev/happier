import { afterEach, describe, expect, it, vi } from 'vitest';

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

afterEach(async () => {
    vi.useRealTimers();
    try {
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
    } catch {
        // ignore
    }
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS;
});

function installDefaultActiveServerMocks() {
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({
            serverId: 'server-a',
            serverUrl: 'https://api.example.test',
            kind: 'custom',
            generation: 1,
        }),
    }));
}

function installTokenStorageMock(params: { failGetCredentials?: boolean } = {}) {
    vi.doMock('@/auth/storage/tokenStorage', () => ({
        TokenStorage: {
            getCredentials: vi.fn(async () => {
                if (params.failGetCredentials) {
                    throw new Error('Unexpected TokenStorage.getCredentials() call');
                }
                return { token: 'token-a', secret: 'secret-a' };
            }),
            invalidateCredentialsTokenForServerUrl: vi.fn(async () => false),
        },
    }));
}

function installRuntimeFetchMock() {
    const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : String(input);
        if (url.endsWith('/health')) {
            throw new TypeError('Network request failed');
        }
        if (url.endsWith('/v1/account/profile')) {
            return new Response(null, { status: 200, headers: new Headers() });
        }
        return new Response(null, { status: 200, headers: new Headers() });
    });

    vi.doMock('@/utils/system/runtimeFetch', () => ({
        runtimeFetch: runtimeFetchMock,
        resetRuntimeFetch: () => {},
        setRuntimeFetch: () => {},
    }));

    return runtimeFetchMock;
}

describe('serverFetch connectivity supervision', () => {
    it('does not attempt the main request when server reachability cannot be established', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        installDefaultActiveServerMocks();
        installTokenStorageMock();
        const runtimeFetchMock = installRuntimeFetchMock();

        const { serverFetch } = await import('./client');
        const promise = serverFetch('/v1/account/profile');
        const assertion = expect(promise).rejects.toMatchObject({
            name: 'ServerFetchConnectivityTimeoutError',
        });
        await vi.advanceTimersByTimeAsync(5);
        await assertion;

        expect(runtimeFetchMock).toHaveBeenCalled();
        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).includes('/v1/account/profile'))).toBe(false);
    });

    it('marks connectivity timeouts as non-retryable (prevents nested backoff loops)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        installDefaultActiveServerMocks();
        installTokenStorageMock();
        installRuntimeFetchMock();

        const { serverFetch } = await import('./client');
        const promise = serverFetch('/v1/account/profile');
        const assertion = expect(promise).rejects.toMatchObject({
            name: 'ServerFetchConnectivityTimeoutError',
            retryable: false,
        });
        await vi.advanceTimersByTimeAsync(5);
        await assertion;
    });

    it('still gates reachability when includeAuth=false but a bearer Authorization header is provided', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        installDefaultActiveServerMocks();
        installTokenStorageMock({ failGetCredentials: true });
        const runtimeFetchMock = installRuntimeFetchMock();

        const { serverFetch } = await import('./client');
        const promise = serverFetch(
            '/v1/account/profile',
            { headers: { Authorization: 'Bearer token-a' } },
            { includeAuth: false },
        );
        const assertion = expect(promise).rejects.toMatchObject({
            name: 'ServerFetchConnectivityTimeoutError',
        });
        await vi.advanceTimersByTimeAsync(5);
        await assertion;

        expect(runtimeFetchMock).toHaveBeenCalled();
        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).includes('/v1/account/profile'))).toBe(false);
    });

    it('gates reachability even when includeAuth=false and no Authorization header is provided', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        installDefaultActiveServerMocks();
        installTokenStorageMock({ failGetCredentials: true });
        const runtimeFetchMock = installRuntimeFetchMock();

        const { serverFetch } = await import('./client');
        const promise = serverFetch('/v1/account/profile', undefined, { includeAuth: false });
        const assertion = expect(promise).rejects.toMatchObject({
            name: 'ServerFetchConnectivityTimeoutError',
        });
        await vi.advanceTimersByTimeAsync(5);
        await assertion;

        expect(runtimeFetchMock).toHaveBeenCalled();
        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).includes('/v1/account/profile'))).toBe(false);
    });

    it('does not clobber reachability auth_failed state when includeAuth=false (token is known from other transports)', async () => {
        installDefaultActiveServerMocks();
        installTokenStorageMock({ failGetCredentials: true });

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                return new Response('ok', { status: 200, headers: new Headers() });
            }
            if (url.endsWith('/v1/auth/ping')) {
                return new Response(null, { status: 401, headers: new Headers() });
            }
            if (url.endsWith('/v1/account/profile')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });

        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { waitForServerReachable, subscribeServerReachabilityState } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await waitForServerReachable({
            serverUrl: 'https://api.example.test',
            token: 'token-a',
            timeoutMs: 5_000,
            acceptAuthFailed: true,
        });

        let lastPhase = '';
        const unsubscribe = subscribeServerReachabilityState('https://api.example.test', (state) => {
            lastPhase = state.phase;
        });
        expect(lastPhase).toBe('auth_failed');

        const { serverFetch } = await import('./client');
        await expect(serverFetch('/v1/account/profile', undefined, { includeAuth: false })).resolves.toMatchObject({
            ok: true,
            status: 200,
        });

        expect(lastPhase).toBe('auth_failed');
        unsubscribe();
    });

    it('does not bypass offline backoff when called repeatedly while unreachable', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '25';

        installDefaultActiveServerMocks();
        installTokenStorageMock();
        const runtimeFetchMock = installRuntimeFetchMock();

        const { serverFetch } = await import('./client');

        const first = serverFetch('/v1/account/profile');
        const firstAssertion = expect(first).rejects.toMatchObject({
            name: 'ServerFetchConnectivityTimeoutError',
        });
        await vi.advanceTimersByTimeAsync(25);
        await firstAssertion;

        const second = serverFetch('/v1/account/profile');
        const secondAssertion = expect(second).rejects.toMatchObject({
            name: 'ServerFetchConnectivityTimeoutError',
        });
        await vi.advanceTimersByTimeAsync(25);
        await secondAssertion;

        expect(runtimeFetchMock).toHaveBeenCalled();
        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).includes('/v1/account/profile'))).toBe(false);
    });

    it('dedupes the initial reachability start/probe across concurrent callers', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        installDefaultActiveServerMocks();
        installTokenStorageMock();
        const runtimeFetchMock = installRuntimeFetchMock();

        const { serverFetch } = await import('./client');
        const first = serverFetch('/v1/account/profile');
        const second = serverFetch('/v1/account/profile');
        const firstAssertion = expect(first).rejects.toMatchObject({ name: 'ServerFetchConnectivityTimeoutError' });
        const secondAssertion = expect(second).rejects.toMatchObject({ name: 'ServerFetchConnectivityTimeoutError' });

        await vi.advanceTimersByTimeAsync(5);
        await firstAssertion;
        await secondAssertion;

        const healthCalls = runtimeFetchMock.mock.calls.filter(([input]) => String(input).endsWith('/health'));
        expect(healthCalls).toHaveLength(1);
    });

    it('does not get retried by default backoff when reachability times out', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        installDefaultActiveServerMocks();
        installTokenStorageMock();
        const runtimeFetchMock = installRuntimeFetchMock();

        const { createBackoff } = await import('@/utils/timing/time');
        const backoff = createBackoff({
            minDelay: 1,
            maxDelay: 1,
            maxFailureCount: 3,
            onError: () => {},
            onRetry: () => {},
        });

        const { serverFetch } = await import('./client');
        const promise = backoff(() => serverFetch('/v1/account/profile'));
        const assertion = expect(promise).rejects.toMatchObject({ name: 'ServerFetchConnectivityTimeoutError' });

        await vi.advanceTimersByTimeAsync(5);
        await assertion;

        // If the error were treated as retryable, the backoff loop would schedule a retry and re-run the probe.
        await vi.advanceTimersByTimeAsync(10);
        const healthCalls = runtimeFetchMock.mock.calls.filter(([input]) => String(input).endsWith('/health'));
        expect(healthCalls).toHaveLength(1);
    });

    it('does not mark the server unreachable when a request is aborted by the caller', async () => {
        installDefaultActiveServerMocks();
        installTokenStorageMock();

        const profileGate = createDeferred<void>();
        const profileStarted = createDeferred<void>();
        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                return new Response('ok', { status: 200, headers: new Headers() });
            }
            if (url.endsWith('/v1/auth/ping')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (url.endsWith('/v1/account/profile')) {
                profileStarted.resolve(undefined);
                await profileGate.promise;
                if (init?.signal?.aborted) {
                    const error = new Error('Aborted');
                    (error as any).name = 'AbortError';
                    throw error;
                }
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });

        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { subscribeServerReachabilityState, waitForServerReachable } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await waitForServerReachable({
            serverUrl: 'https://api.example.test',
            token: 'token-a',
            timeoutMs: 5_000,
            acceptAuthFailed: true,
        });

        let lastReachabilityPhase = '';
        const unsubscribe = subscribeServerReachabilityState('https://api.example.test', (state) => {
            lastReachabilityPhase = state.phase;
        });
        expect(lastReachabilityPhase).toBe('online');

        const { serverFetch } = await import('./client');
        const abortController = new AbortController();
        const requestPromise = serverFetch('/v1/account/profile', { signal: abortController.signal });

        await profileStarted.promise;
        abortController.abort();
        profileGate.resolve(undefined);

        await expect(requestPromise).rejects.toMatchObject({ name: 'AbortError' });
        expect(lastReachabilityPhase).toBe('online');

        unsubscribe();
    });

    it('does not log basic-auth secrets when debug logging is enabled', async () => {
        const previousDebug = process.env.EXPO_PUBLIC_DEBUG;
        process.env.EXPO_PUBLIC_DEBUG = '1';

        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'https://admin:secret@api.example.test',
                kind: 'custom',
                generation: 1,
            }),
        }));
        installTokenStorageMock();

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                return new Response('ok', { status: 200, headers: new Headers() });
            }
            if (url.endsWith('/v1/auth/ping')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            if (url.includes('/v1/account/profile')) {
                throw new TypeError('Network request failed');
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const { serverFetch } = await import('./client');
            await expect(serverFetch('/v1/account/profile')).rejects.toBeDefined();

            const logged = consoleSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
            expect(logged).not.toContain('secret');
            expect(logged).not.toContain('admin:');
        } finally {
            consoleSpy.mockRestore();
            if (previousDebug === undefined) delete process.env.EXPO_PUBLIC_DEBUG;
            else process.env.EXPO_PUBLIC_DEBUG = previousDebug;
        }
    });
});
