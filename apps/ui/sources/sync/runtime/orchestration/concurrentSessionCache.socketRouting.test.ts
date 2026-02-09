import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ioSpy = vi.fn();
const getCredentialsForServerUrlSpy = vi.fn();
const listServerProfilesSpy = vi.fn();
const getActiveServerSnapshotSpy = vi.fn();

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    ioSpy.mockReset();
    getCredentialsForServerUrlSpy.mockReset();
    listServerProfilesSpy.mockReset();
    getActiveServerSnapshotSpy.mockReset();

});

afterEach(() => {
    vi.useRealTimers();
    delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
});

describe('concurrent session cache socket routing', () => {
    it('opens non-active server sockets with server-scoped credentials', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';

        const fakeSocket = {
            on: vi.fn(),
            onAny: vi.fn(),
            disconnect: vi.fn(),
        };
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockImplementation(async (serverUrl: string) => {
            if (serverUrl === 'https://stack-b.example.test') {
                return { token: 'token-b', secret: 'secret-b' };
            }
            return null;
        });
        listServerProfilesSpy.mockReturnValue([
            { id: 'server-a', serverUrl: 'https://stack-a.example.test', name: 'Server A' },
            { id: 'server-b', serverUrl: 'https://stack-b.example.test', name: 'Server B' },
        ]);
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://stack-a.example.test',
            kind: 'stack',
            generation: 1,
        });

        vi.doMock('socket.io-client', () => ({
            io: (...args: unknown[]) => ioSpy(...args),
        }));
        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsForServerUrlSpy(...args),
            },
        }));
        vi.doMock('@/sync/domains/server/serverProfiles', () => ({
            listServerProfiles: () => listServerProfilesSpy(),
        }));
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => getActiveServerSnapshotSpy(),
            subscribeActiveServer: () => () => {},
        }));
        vi.doMock('@/sync/encryption/encryption', () => ({
            Encryption: {
                create: async () => ({}) as unknown,
            },
        }));
        vi.doMock('@/encryption/base64', () => ({
            decodeBase64: () => new Uint8Array(32),
        }));
        vi.doMock('@/sync/engine/sessions/sessionSnapshot', () => ({
            fetchAndApplySessions: async ({ applySessions }: { applySessions: (sessions: unknown[]) => void }) => {
                applySessions([]);
            },
        }));
        vi.doMock('@/sync/engine/machines/syncMachines', () => ({
            fetchAndApplyMachines: async ({ applyMachines }: { applyMachines: (machines: unknown[]) => void }) => {
                applyMachines([]);
            },
        }));

        const { storage } = await import('@/sync/domains/state/storageStore');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        storage.setState((state) => ({
            ...state,
            settings: {
                ...state.settings,
                ...settingsDefaults,
                multiServerEnabled: true,
                multiServerSelectedServerIds: ['server-a', 'server-b'],
                multiServerPresentation: 'grouped',
            },
        }));

        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');

        startConcurrentSessionCacheSync();
        await vi.runOnlyPendingTimersAsync();
        await vi.runOnlyPendingTimersAsync();

        expect(ioSpy).toHaveBeenCalledTimes(1);
        expect(ioSpy).toHaveBeenCalledWith(
            'https://stack-b.example.test',
            expect.objectContaining({
                path: '/v1/updates',
                auth: expect.objectContaining({
                    token: 'token-b',
                    clientType: 'user-scoped',
                }),
            }),
        );

        stopConcurrentSessionCacheSync();
    });

    it('keeps concurrent session cache updates isolated per server when two servers refresh concurrently', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';

        const fakeSocketB = {
            on: vi.fn(),
            onAny: vi.fn(),
            disconnect: vi.fn(),
        };
        const fakeSocketC = {
            on: vi.fn(),
            onAny: vi.fn(),
            disconnect: vi.fn(),
        };
        ioSpy.mockImplementation((serverUrl: string) => {
            if (serverUrl === 'https://stack-b.example.test') return fakeSocketB;
            if (serverUrl === 'https://stack-c.example.test') return fakeSocketC;
            return {
                on: vi.fn(),
                onAny: vi.fn(),
                disconnect: vi.fn(),
            };
        });

        getCredentialsForServerUrlSpy.mockImplementation(async (serverUrl: string) => {
            if (serverUrl === 'https://stack-b.example.test') return { token: 'token-b', secret: 'secret-b' };
            if (serverUrl === 'https://stack-c.example.test') return { token: 'token-c', secret: 'secret-c' };
            return null;
        });

        listServerProfilesSpy.mockReturnValue([
            { id: 'server-a', serverUrl: 'https://stack-a.example.test', name: 'Server A' },
            { id: 'server-b', serverUrl: 'https://stack-b.example.test', name: 'Server B' },
            { id: 'server-c', serverUrl: 'https://stack-c.example.test', name: 'Server C' },
        ]);
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://stack-a.example.test',
            kind: 'stack',
            generation: 1,
        });

        vi.doMock('socket.io-client', () => ({
            io: (...args: unknown[]) => ioSpy(...args),
        }));
        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsForServerUrlSpy(...args),
            },
        }));
        vi.doMock('@/sync/domains/server/serverProfiles', () => ({
            listServerProfiles: () => listServerProfilesSpy(),
        }));
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => getActiveServerSnapshotSpy(),
            subscribeActiveServer: () => () => {},
        }));
        vi.doMock('@/sync/encryption/encryption', () => ({
            Encryption: {
                create: async () => ({}) as unknown,
            },
        }));
        vi.doMock('@/encryption/base64', () => ({
            decodeBase64: () => new Uint8Array(32),
        }));
        vi.doMock('@/sync/engine/sessions/sessionSnapshot', () => ({
            fetchAndApplySessions: async ({
                credentials,
                applySessions,
            }: {
                credentials: { token: string };
                applySessions: (sessions: unknown[]) => void;
            }) => {
                if (credentials.token === 'token-b') {
                    applySessions([{
                        id: 'session-b',
                        seq: 1,
                        createdAt: 1000,
                        updatedAt: 2000,
                        active: true,
                        activeAt: 2000,
                        metadata: { machineId: 'machine-b', path: '/workspace/b', host: 'b-host' },
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 0,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                    }]);
                    return;
                }
                applySessions([{
                    id: 'session-c',
                    seq: 1,
                    createdAt: 1000,
                    updatedAt: 2100,
                    active: true,
                    activeAt: 2100,
                    metadata: { machineId: 'machine-c', path: '/workspace/c', host: 'c-host' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                }]);
            },
        }));
        vi.doMock('@/sync/engine/machines/syncMachines', () => ({
            fetchAndApplyMachines: async ({
                credentials,
                applyMachines,
            }: {
                credentials: { token: string };
                applyMachines: (machines: unknown[]) => void;
            }) => {
                if (credentials.token === 'token-b') {
                    applyMachines([{
                        id: 'machine-b',
                        seq: 1,
                        createdAt: 1000,
                        updatedAt: 2000,
                        active: true,
                        activeAt: 2000,
                        metadata: { host: 'b-host', path: '/workspace/b' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    }]);
                    return;
                }
                applyMachines([{
                    id: 'machine-c',
                    seq: 1,
                    createdAt: 1000,
                    updatedAt: 2100,
                    active: true,
                    activeAt: 2100,
                    metadata: { host: 'c-host', path: '/workspace/c' },
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                }]);
            },
        }));

        const { storage } = await import('@/sync/domains/state/storageStore');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        storage.setState((state) => ({
            ...state,
            settings: {
                ...state.settings,
                ...settingsDefaults,
                multiServerEnabled: true,
                multiServerSelectedServerIds: ['server-a', 'server-b', 'server-c'],
                multiServerPresentation: 'grouped',
            },
        }));

        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        startConcurrentSessionCacheSync();
        await vi.runOnlyPendingTimersAsync();
        await vi.runOnlyPendingTimersAsync();

        const cacheByServer = storage.getState().sessionListViewDataByServerId;
        const serverBItems = cacheByServer['server-b'] ?? [];
        const serverCItems = cacheByServer['server-c'] ?? [];

        const serverBSessionIds = serverBItems
            .flatMap((item: any) => (item?.type === 'active-sessions' ? item.sessions : []))
            .map((session: any) => session.id);
        const serverCSessionIds = serverCItems
            .flatMap((item: any) => (item?.type === 'active-sessions' ? item.sessions : []))
            .map((session: any) => session.id);

        expect(serverBSessionIds).toContain('session-b');
        expect(serverBSessionIds).not.toContain('session-c');
        expect(serverCSessionIds).toContain('session-c');
        expect(serverCSessionIds).not.toContain('session-b');

        stopConcurrentSessionCacheSync();
    });
});
