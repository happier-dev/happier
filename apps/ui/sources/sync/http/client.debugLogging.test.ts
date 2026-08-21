import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(async () => {
    const { resetRuntimeFetch } = await import('./client');
    resetRuntimeFetch();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

describe('serverFetch debug logging', () => {
    it('recognizes every loopback address when explaining a device-unreachable relay', async () => {
        const previousDebug = process.env.EXPO_PUBLIC_DEBUG;
        process.env.EXPO_PUBLIC_DEBUG = '1';

        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'http://127.0.0.2:53288',
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
        client.setRuntimeFetch(async () => {
            throw new TypeError('Network request failed');
        });

        await expect(client.serverFetch('/v1/health', undefined, { includeAuth: false, retry: 'none' }))
            .rejects.toThrow('Network request failed');

        const combined = logSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
        expect(combined).toContain('a physical device cannot reach');

        if (previousDebug === undefined) delete process.env.EXPO_PUBLIC_DEBUG;
        else process.env.EXPO_PUBLIC_DEBUG = previousDebug;
    });

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
        (client as unknown as { setRuntimeFetch: (fn: typeof fetch) => void }).setRuntimeFetch(async (request) => {
            throw new TypeError(`Network request failed for ${String(request)}`);
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

    it('templates public-share capabilities when debug request logging is enabled', async () => {
        const previousDebug = process.env.EXPO_PUBLIC_DEBUG;
        process.env.EXPO_PUBLIC_DEBUG = '1';
        const secret = 'SENTINEL_PUBLIC_SHARE_CAPABILITY';

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
        client.setRuntimeFetch(async (request) => {
            throw new TypeError(`Network request failed for ${String(request)}`);
        });

        await expect(client.serverFetch(
            `/v1/public-share/${secret}/messages`,
            undefined,
            { includeAuth: false, retry: 'none' },
        )).rejects.toThrow('Network request failed');

        const combined = logSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
        expect(combined).not.toContain(secret);
        expect(combined).toContain('/v1/public-share/:token/messages');

        if (previousDebug === undefined) delete process.env.EXPO_PUBLIC_DEBUG;
        else process.env.EXPO_PUBLIC_DEBUG = previousDebug;
    });
});
