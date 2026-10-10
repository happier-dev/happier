import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { peekServerReachabilityState, subscribeServerReachabilityState } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';

const accountToken = createAccountTokenForTests('write-account');

beforeEach(async () => {
    await upsertAndActivateServer({ serverUrl: 'https://api.example.test', name: 'Write Home' });
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: accountToken });
});

afterEach(async () => {
    vi.useRealTimers();
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    await resetServerReachabilitySupervisors();
    const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
    await stopAllEndpointSupervisorsForTests();
    resetRuntimeFetch();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_WRITE_TIMEOUT_MS;
});

describe('serverFetch write timeout', () => {
    it('aborts a stalled mutating request with a retryable timeout without declaring the Home unreachable', async () => {
        vi.useFakeTimers();
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_WRITE_TIMEOUT_MS = '50';
        setRuntimeFetch(async (input, init) => {
                const url = typeof input === 'string' ? input : String(input);
                if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                    return new Response('ok', { status: 200 });
                }
                await new Promise<void>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        // Native transports may reject cancellation without an
                        // AbortError name; the request signal owns that fact.
                        reject(new TypeError('Transport cancelled'));
                    }, { once: true });
                });
                return new Response(null, { status: 200 });
        });

        const { serverFetch } = await import('./client');
        const unsubscribe = subscribeServerReachabilityState('https://api.example.test', () => {}, accountToken);
        const request = serverFetch(
            '/v2/sessions/s1/pending',
            { method: 'POST', body: '{}' },
            { timeoutMs: 50 },
        );
        const assertion = expect(request).rejects.toMatchObject({
            name: 'ServerFetchWriteTimeoutError',
            retryable: true,
        });
        await vi.advanceTimersByTimeAsync(60);
        await assertion;
        try {
            expect(peekServerReachabilityState('https://api.example.test', accountToken)?.phase).toBe('online');
        } finally {
            unsubscribe();
        }
    });

    it('classifies write timeouts as transient and leaves GET reads unbounded', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_WRITE_TIMEOUT_MS = '50';
        setRuntimeFetch(async () => new Response('body', { status: 200 }));

        const { serverFetch, ServerFetchWriteTimeoutError } = await import('./client');
        const { isTransientConnectivityError } = await import('@/sync/runtime/connectivity/transientConnectivityErrors');
        expect(isTransientConnectivityError(new ServerFetchWriteTimeoutError())).toBe(true);
        await expect(serverFetch('/v2/sessions/s1/messages', { method: 'GET' })).resolves.toMatchObject({ ok: true });
    });
});
