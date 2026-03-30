import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(async () => {
    const { resetRuntimeFetch } = await import('./client');
    resetRuntimeFetch();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

describe('serverFetch debug logging', () => {
    it('logs request URL context when EXPO_PUBLIC_DEBUG=1 and runtime fetch fails', async () => {
        const previousDebug = process.env.EXPO_PUBLIC_DEBUG;
        process.env.EXPO_PUBLIC_DEBUG = '1';

        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'http://localhost:53288',
                generation: 1,
            }),
        }));
        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () => null),
                invalidateCredentialsTokenForServerUrl: vi.fn(async () => false),
            },
        }));

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const client = await import('./client');
        (client as unknown as { setRuntimeFetch: (fn: typeof fetch) => void }).setRuntimeFetch(async () => {
            throw new TypeError('Network request failed');
        });

        await expect((client as unknown as { serverFetch: typeof import('./client').serverFetch }).serverFetch(
            '/v1/health',
            undefined,
            { includeAuth: false, retry: 'none' },
        )).rejects.toThrow('Network request failed');

        expect(logSpy).toHaveBeenCalled();
        const combined = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
        expect(combined).toContain('serverFetch');
        expect(combined).toContain('http://localhost:53288/v1/health');

        if (previousDebug === undefined) delete process.env.EXPO_PUBLIC_DEBUG;
        else process.env.EXPO_PUBLIC_DEBUG = previousDebug;
    });
});
