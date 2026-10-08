import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const connectivityToken = createAccountTokenForTests('connectivity-account');

beforeEach(async () => {
    await upsertAndActivateServer({ serverUrl: 'https://api.example.test', name: 'Connectivity Home' });
});

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
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    await resetServerReachabilitySupervisors();
    const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
    await stopAllEndpointSupervisorsForTests();
    resetRuntimeFetch();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS;
});

function installTokenStorageBoundary(params: { failGetCredentials?: boolean } = {}) {
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async () => {
        if (params.failGetCredentials) throw new Error('Unexpected credential read');
        return { token: connectivityToken };
    });
}

function installRuntimeFetchMock() {
    const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : String(input);
        // "The network is down" must fail every readiness route: an authenticated client probes /v1/auth/ping,
        // a tokenless one probes /health.
        if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
            throw new TypeError('Network request failed');
        }
        if (url.endsWith('/v1/account/profile')) {
            return new Response(null, { status: 200, headers: new Headers() });
        }
        return new Response(null, { status: 200, headers: new Headers() });
    });

    setRuntimeFetch(runtimeFetchMock);

    return runtimeFetchMock;
}

describe('serverFetch connectivity supervision', () => {
    it('does not attempt the main request when server reachability cannot be established', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        installTokenStorageBoundary();
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

    it('classifies connectivity timeouts through the shared retry owner', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        installTokenStorageBoundary();
        installRuntimeFetchMock();

        const { serverFetch } = await import('./client');
        const promise = serverFetch('/v1/account/profile');
        const assertion = expect(promise).rejects.toMatchObject({ name: 'ServerFetchConnectivityTimeoutError' });
        const error = promise.catch((failure: unknown) => failure);
        await vi.advanceTimersByTimeAsync(5);
        await assertion;
        const { shouldRetryError } = await import('@/sync/runtime/connectivity/transientConnectivityErrors');
        expect(shouldRetryError(await error)).toBe(true);
    });

    it('still gates reachability when includeAuth=false but a bearer Authorization header is provided', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        installTokenStorageBoundary({ failGetCredentials: true });
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

        installTokenStorageBoundary({ failGetCredentials: true });
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
        installTokenStorageBoundary({ failGetCredentials: true });

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

        setRuntimeFetch(runtimeFetchMock);

        const { waitForServerReachable, subscribeServerReachabilityState } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await waitForServerReachable({
            serverUrl: 'https://api.example.test',
            token: connectivityToken,
            timeoutMs: 5_000,
            acceptAuthFailed: true,
        });

        let lastPhase = '';
        const unsubscribe = subscribeServerReachabilityState('https://api.example.test', (state) => {
            lastPhase = state.phase;
        }, connectivityToken);
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

        installTokenStorageBoundary();
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

        installTokenStorageBoundary();
        const runtimeFetchMock = installRuntimeFetchMock();

        const { serverFetch } = await import('./client');
        const first = serverFetch('/v1/account/profile');
        const second = serverFetch('/v1/account/profile');
        const firstAssertion = expect(first).rejects.toMatchObject({ name: 'ServerFetchConnectivityTimeoutError' });
        const secondAssertion = expect(second).rejects.toMatchObject({ name: 'ServerFetchConnectivityTimeoutError' });

        await vi.advanceTimersByTimeAsync(5);
        await firstAssertion;
        await secondAssertion;

        const probeCalls = runtimeFetchMock.mock.calls.filter(([input]) => String(input).endsWith('/v1/auth/ping'));
        expect(probeCalls).toHaveLength(1);
    });

    it('lets enclosing backoff recover a connectivity timeout without restarting the offline probe', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        installTokenStorageBoundary();
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
        let attempts = 0;
        const promise = backoff(async () => {
            attempts += 1;
            // The containing operation owns recovery; this request continues
            // using the existing offline supervisor rather than forcing a probe.
            if (attempts === 3) return 'recovered';
            return await serverFetch('/v1/account/profile');
        });
        const assertion = expect(promise).resolves.toBe('recovered');

        await vi.advanceTimersByTimeAsync(12);
        await assertion;

        expect(attempts).toBe(3);
        const probeCalls = runtimeFetchMock.mock.calls.filter(([input]) => String(input).endsWith('/v1/auth/ping'));
        expect(probeCalls).toHaveLength(1);
        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).includes('/v1/account/profile'))).toBe(false);
    });

    it('does not mark the server unreachable when a request is aborted by the caller', async () => {
        installTokenStorageBoundary();

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
                    error.name = 'AbortError';
                    throw error;
                }
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });

        setRuntimeFetch(runtimeFetchMock);

        const { subscribeServerReachabilityState, waitForServerReachable } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await waitForServerReachable({
            serverUrl: 'https://api.example.test',
            token: connectivityToken,
            timeoutMs: 5_000,
            acceptAuthFailed: true,
        });

        let lastReachabilityPhase = '';
        const unsubscribe = subscribeServerReachabilityState('https://api.example.test', (state) => {
            lastReachabilityPhase = state.phase;
        }, connectivityToken);
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

        await upsertAndActivateServer({ serverUrl: 'https://admin:secret@api.example.test', name: 'Private endpoint Home' });
        installTokenStorageBoundary();

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
        setRuntimeFetch(runtimeFetchMock);

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
