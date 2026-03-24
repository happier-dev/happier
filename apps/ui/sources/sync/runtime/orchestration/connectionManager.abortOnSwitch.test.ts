import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

describe('switchConnectionToActiveServer', () => {
    it('uses server-scoped credentials for the active server when switching sync server', async () => {
        const abortSpy = vi.fn();
        const syncSwitchServerSpy = vi.fn(async (_credentials: { token: string; secret: string }) => {});
        const getCredentialsSpy = vi.fn(async () => null);
        const getCredentialsForServerUrlSpy = vi.fn(async () => ({ token: 'scoped-token', secret: 'scoped-secret' }));

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
                getCredentials: getCredentialsSpy,
                getCredentialsForServerUrl: getCredentialsForServerUrlSpy,
            },
        }));
        vi.doMock('@/sync/sync', () => ({
            syncSwitchServer: syncSwitchServerSpy,
        }));
        vi.doMock('@/sync/http/client', () => ({
            abortServerFetches: abortSpy,
        }));

        const { switchConnectionToActiveServer } = await import('./connectionManager');
        await expect(switchConnectionToActiveServer()).resolves.toEqual({
            token: 'scoped-token',
            secret: 'scoped-secret',
        });

        expect(getCredentialsForServerUrlSpy).toHaveBeenCalledWith('https://api.example.test', { serverId: 'server-a' });
        expect(getCredentialsSpy).not.toHaveBeenCalled();
        expect(syncSwitchServerSpy).toHaveBeenCalledWith({ token: 'scoped-token', secret: 'scoped-secret' });
    });

    it('aborts in-flight server fetches before switching sync server', async () => {
        const abortSpy = vi.fn();
        const syncSwitchServerSpy = vi.fn(async (_credentials: { token: string; secret: string }) => {});
        const getCredentialsSpy = vi.fn(async () => ({ token: 'fallback', secret: 'fallback-secret' }));
        const getCredentialsForServerUrlSpy = vi.fn(async () => ({ token: 't', secret: 's' }));

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
                getCredentials: getCredentialsSpy,
                getCredentialsForServerUrl: getCredentialsForServerUrlSpy,
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

        expect(getCredentialsForServerUrlSpy).toHaveBeenCalledWith('https://api.example.test', { serverId: 'server-a' });
        expect(getCredentialsSpy).not.toHaveBeenCalled();
        expect(abortSpy).toHaveBeenCalledTimes(1);
        expect(syncSwitchServerSpy).toHaveBeenCalledTimes(1);
    });

    it('applies latest server generation after a switch happens during an in-flight switch', async () => {
        let generation = 1;
        const abortSpy = vi.fn();
        const switchStarted = createDeferred<void>();
        const releaseSwitch = createDeferred<void>();
        let syncCallCount = 0;
        const getCredentialsSpy = vi.fn(async () => null);
        const getCredentialsForServerUrlSpy = vi.fn(async (serverUrl: string) =>
            serverUrl === 'https://a.example.test'
                ? { token: 'token-a', secret: 's' }
                : { token: 'token-b', secret: 's' },
        );
        const syncSwitchServerSpy = vi.fn(async (_credentials: { token: string; secret: string }) => {
            syncCallCount += 1;
            if (syncCallCount > 1) return;
            switchStarted.resolve();
            await releaseSwitch.promise;
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
                getCredentials: getCredentialsSpy,
                getCredentialsForServerUrl: getCredentialsForServerUrlSpy,
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
        await switchStarted.promise;
        releaseSwitch.resolve();
        await Promise.all([first, second]);

        expect(abortSpy).toHaveBeenCalledTimes(2);
        expect(syncSwitchServerSpy).toHaveBeenCalledTimes(2);
        expect(getCredentialsForServerUrlSpy).toHaveBeenNthCalledWith(1, 'https://a.example.test', { serverId: 'server-a' });
        expect(getCredentialsForServerUrlSpy).toHaveBeenNthCalledWith(2, 'https://b.example.test', { serverId: 'server-b' });
        expect(getCredentialsSpy).not.toHaveBeenCalled();
        expect(syncSwitchServerSpy.mock.calls.at(-1)?.[0]).toEqual({ token: 'token-b', secret: 's' });
    });
});
