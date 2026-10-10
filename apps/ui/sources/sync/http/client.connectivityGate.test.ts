import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const accountToken = createAccountTokenForTests('connectivity-account');

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
});

function installTokenStorageBoundary(params: { failGetCredentials?: boolean } = {}) {
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async () => {
        if (params.failGetCredentials) throw new Error('Unexpected credential read');
        return { token: accountToken };
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
    it('does not publish a Home outage when a local pre-dispatch callback throws', async () => {
        installTokenStorageBoundary();
        setRuntimeFetch(async () => new Response(null, { status: 200 }));
        const { subscribeServerReachabilityState, peekServerReachabilityState } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const unsubscribe = subscribeServerReachabilityState('https://api.example.test', () => {}, accountToken);
        const { serverFetch } = await import('./client');
        const error = new Error('Local callback failure');
        try {
            await expect(serverFetch('/v1/account/profile', {}, { onIssued: () => { throw error; } })).rejects.toBe(error);
            expect(peekServerReachabilityState('https://api.example.test', accountToken)?.phase).toBe('online');
        } finally {
            unsubscribe();
        }
    });
    it.each(['stored-credentials', 'explicit-authorization', 'unauthenticated'] as const)(
        'keeps an offline %s request pending until caller cancellation without sending the domain request', async (authentication) => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0);

        installTokenStorageBoundary({ failGetCredentials: authentication !== 'stored-credentials' });
        const runtimeFetchMock = installRuntimeFetchMock();
        const { serverFetch } = await import('./client');
        const controller = new AbortController();
        const promise = serverFetch(
            '/v1/account/profile',
            { signal: controller.signal, ...(authentication === 'explicit-authorization'
                ? { headers: { Authorization: `Bearer ${accountToken}` } } : {}) },
            { includeAuth: authentication === 'stored-credentials' },
        );
        const settled = vi.fn();
        void promise.then(settled, settled);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(settled).not.toHaveBeenCalled();
        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).endsWith(
            authentication === 'unauthenticated' ? '/health' : '/v1/auth/ping',
        ))).toBe(true);
        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).includes('/v1/account/profile'))).toBe(false);

        const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        controller.abort();
        await assertion;
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
            token: accountToken,
            timeoutMs: 5_000,
            acceptAuthFailed: true,
        });

        let lastPhase = '';
        const unsubscribe = subscribeServerReachabilityState('https://api.example.test', (state) => {
            lastPhase = state.phase;
        }, accountToken);
        expect(lastPhase).toBe('auth_failed');

        const { serverFetch } = await import('./client');
        await expect(serverFetch('/v1/account/profile', undefined, { includeAuth: false })).resolves.toMatchObject({
            ok: true,
            status: 200,
        });

        expect(lastPhase).toBe('auth_failed');
        unsubscribe();
    });

    it('dedupes the initial reachability start/probe across concurrent callers', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
        installTokenStorageBoundary();
        const readiness = createDeferred<Response>();
        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input).endsWith('/v1/auth/ping')) return await readiness.promise;
            return new Response(null, { status: 200 });
        });
        setRuntimeFetch(runtimeFetchMock);

        const { serverFetch } = await import('./client');
        const first = serverFetch('/v1/account/profile');
        const second = serverFetch('/v1/account/profile');
        await vi.advanceTimersByTimeAsync(0);

        const probeCalls = runtimeFetchMock.mock.calls.filter(([input]) => String(input).endsWith('/v1/auth/ping'));
        expect(probeCalls).toHaveLength(1);
        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).includes('/v1/account/profile'))).toBe(false);
        readiness.resolve(new Response(null, { status: 200 }));
        await expect(Promise.all([first, second])).resolves.toMatchObject([{ status: 200 }, { status: 200 }]);
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
            token: accountToken,
            timeoutMs: 5_000,
            acceptAuthFailed: true,
        });

        let lastReachabilityPhase = '';
        const unsubscribe = subscribeServerReachabilityState('https://api.example.test', (state) => {
            lastReachabilityPhase = state.phase;
        }, accountToken);
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
