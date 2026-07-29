import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(async () => {
    vi.useRealTimers();
    try {
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
    } catch {
        // Best-effort cleanup when the module did not finish loading.
    }
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_WRITE_TIMEOUT_MS;
});

function installActiveServerMocks() {
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({
            serverId: 'server-a',
            serverUrl: 'https://api.example.test',
            kind: 'custom',
            generation: 1,
        }),
    }));
    vi.doMock('@/auth/storage/tokenStorage', () => ({
        TokenStorage: {
            getCredentials: vi.fn(async () => ({ token: 'token-a', secret: 'secret-a' })),
            invalidateCredentialsTokenForServerUrl: vi.fn(async () => false),
        },
    }));
}

describe('serverFetch write timeout', () => {
    it('aborts a stalled mutating request with a retryable timeout', async () => {
        vi.useFakeTimers();
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_WRITE_TIMEOUT_MS = '50';
        installActiveServerMocks();
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : String(input);
                if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                    return new Response('ok', { status: 200 });
                }
                await new Promise<void>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        const error = new Error('Aborted');
                        error.name = 'AbortError';
                        reject(error);
                    }, { once: true });
                });
                return new Response(null, { status: 200 });
            }),
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { serverFetch } = await import('./client');
        const request = serverFetch('/v2/sessions/s1/pending', { method: 'POST', body: '{}' });
        const assertion = expect(request).rejects.toMatchObject({
            name: 'ServerFetchWriteTimeoutError',
            retryable: true,
        });
        await vi.advanceTimersByTimeAsync(60);
        await assertion;
    });

    it('classifies write timeouts as transient and leaves GET reads unbounded', async () => {
        installActiveServerMocks();
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_WRITE_TIMEOUT_MS = '50';
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: vi.fn(async () => new Response('body', { status: 200 })),
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { serverFetch, ServerFetchWriteTimeoutError } = await import('./client');
        const { isTransientConnectivityError } = await import('@/sync/runtime/connectivity/transientConnectivityErrors');
        expect(isTransientConnectivityError(new ServerFetchWriteTimeoutError())).toBe(true);
        await expect(serverFetch('/v2/sessions/s1/messages', { method: 'GET' })).resolves.toMatchObject({ ok: true });
    });
});
