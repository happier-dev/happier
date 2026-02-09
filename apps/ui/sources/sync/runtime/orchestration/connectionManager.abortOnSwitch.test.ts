import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

describe('switchConnectionToActiveServer', () => {
    it('aborts in-flight server fetches before switching sync server', async () => {
        const abortSpy = vi.fn();
        const syncSwitchServerSpy = vi.fn(async () => {});

        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'https://api.example.test',
                kind: 'custom',
                generation: 42,
            }),
        }));
        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () => ({ token: 't', secret: 's' })),
            },
        }));
        vi.doMock('@/sync/sync', () => ({
            syncSwitchServer: syncSwitchServerSpy,
        }));
        vi.doMock('@/sync/http/client', () => ({
            abortServerFetches: abortSpy,
        }));

        const { switchConnectionToActiveServer } = await import('./connectionManager');
        await switchConnectionToActiveServer();

        expect(abortSpy).toHaveBeenCalledTimes(1);
        expect(syncSwitchServerSpy).toHaveBeenCalledTimes(1);
    });

    it('applies latest server generation after a switch happens during an in-flight switch', async () => {
        let generation = 1;
        const abortSpy = vi.fn();
        const deferred: { resolve: (() => void) | null } = { resolve: null };
        let syncCallCount = 0;
        const syncSwitchServerSpy = vi.fn(async () => {
            syncCallCount += 1;
            if (syncCallCount > 1) return;
            await new Promise<void>((resolve) => {
                deferred.resolve = resolve;
            });
        });

        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: generation === 1 ? 'server-a' : 'server-b',
                serverUrl: generation === 1 ? 'https://a.example.test' : 'https://b.example.test',
                kind: 'custom',
                generation,
            }),
        }));
        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () =>
                    generation === 1 ? { token: 'token-a', secret: 's' } : { token: 'token-b', secret: 's' }),
            },
        }));
        vi.doMock('@/sync/sync', () => ({
            syncSwitchServer: syncSwitchServerSpy,
        }));
        vi.doMock('@/sync/http/client', () => ({
            abortServerFetches: abortSpy,
        }));

        const { switchConnectionToActiveServer } = await import('./connectionManager');
        const first = switchConnectionToActiveServer();
        generation = 2;
        const second = switchConnectionToActiveServer();
        for (let attempt = 0; attempt < 10 && !deferred.resolve; attempt += 1) {
            await Promise.resolve();
        }
        if (!deferred.resolve) {
            throw new Error('deferred resolver was not initialized');
        }
        deferred.resolve?.();
        await Promise.all([first, second]);

        expect(abortSpy).toHaveBeenCalledTimes(2);
        expect(syncSwitchServerSpy).toHaveBeenCalledTimes(2);
        expect(syncSwitchServerSpy.mock.calls.at(-1)?.[0]).toEqual({ token: 'token-b', secret: 's' });
    });
});
