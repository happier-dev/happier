import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ioSpy = vi.fn();
const getCredentialsForServerUrlSpy = vi.fn();
const listServerProfilesSpy = vi.fn();
const getActiveServerSnapshotSpy = vi.fn();

type SocketEventHandler = (...args: unknown[]) => void;

function createSocketStub() {
    const listeners = new Map<string, Set<SocketEventHandler>>();
    const socket = {
        connected: false,
        on: vi.fn((event: string, handler: SocketEventHandler) => {
            const bucket = listeners.get(event) ?? new Set<SocketEventHandler>();
            bucket.add(handler);
            listeners.set(event, bucket);
            return socket;
        }),
        off: vi.fn((event: string, handler?: SocketEventHandler) => {
            if (!handler) {
                listeners.delete(event);
                return socket;
            }
            listeners.get(event)?.delete(handler);
            return socket;
        }),
        onAny: vi.fn(),
        connect: vi.fn(() => {
            socket.connected = true;
            for (const listener of listeners.get('connect') ?? []) {
                listener();
            }
        }),
        disconnect: vi.fn(() => {
            const wasConnected = socket.connected;
            socket.connected = false;
            if (!wasConnected) {
                return;
            }
            for (const listener of listeners.get('disconnect') ?? []) {
                listener('io client disconnect');
            }
        }),
        removeAllListeners: vi.fn(() => {
            listeners.clear();
        }),
    };
    return socket;
}

function onlineState() {
    return {
        phase: 'online',
        reason: 'initial_connect',
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    };
}

function mockReachabilityOnline() {
    vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
        return {
            ...actual,
            subscribeServerReachabilityState: (_serverUrl: string, listener: (state: any) => void) => {
                const timer = setTimeout(() => {
                    listener(onlineState());
                }, 0);
                return () => clearTimeout(timer);
            },
            startServerReachabilitySupervisor: async () => {},
            reportServerUnreachable: () => {},
            resetServerReachabilitySupervisors: async () => {},
        };
    });
}

async function flushConcurrentCacheStartup(timerCount = 2): Promise<void> {
    for (let index = 0; index < timerCount; index += 1) {
        await vi.advanceTimersToNextTimerAsync();
    }
}

async function flushConcurrentCacheReconcileOnly(): Promise<void> {
    await vi.advanceTimersToNextTimerAsync();
}

async function flushConcurrentCachePeriodicRefresh(): Promise<void> {
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await vi.advanceTimersToNextTimerAsync();
}

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
    it('replaces stale machine entries when an authoritative refresh omits a removed machine', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        mockReachabilityOnline();

        const fakeSocket = createSocketStub();
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
            isLegacyAuthCredentials: (credentials: any) => Boolean(credentials && typeof credentials === 'object' && typeof credentials.secret === 'string'),
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
        const fetchAndApplyMachinesSpy = vi.fn(async ({ applyMachines }: { applyMachines: (machines: unknown[]) => void }) => {
            const call = fetchAndApplyMachinesSpy.mock.calls.length;
            if (call === 1) {
                applyMachines([
                    {
                        id: 'machine-1',
                        seq: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        active: true,
                        activeAt: 1,
                        metadata: { host: 'one' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                    {
                        id: 'machine-2',
                        seq: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        active: false,
                        activeAt: 1,
                        metadata: { host: 'two' },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                ]);
                return;
            }

            // Authoritative refresh response: machine-2 has been removed.
            applyMachines([
                {
                    id: 'machine-1',
                    seq: 2,
                    createdAt: 1,
                    updatedAt: 2,
                    active: true,
                    activeAt: 2,
                    metadata: { host: 'one' },
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                },
            ]);
        });
        vi.doMock('@/sync/engine/machines/syncMachines', () => ({
            fetchAndApplyMachines: (...args: any[]) => (fetchAndApplyMachinesSpy as any)(...args),
        }));

        const { storage } = await import('@/sync/domains/state/storageStore');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        storage.setState((state) => ({
            ...state,
            settings: {
                ...state.settings,
                ...settingsDefaults,
                serverSelectionGroups: [
                    {
                        id: 'group-main',
                        name: 'Main',
                        serverIds: ['server-a', 'server-b'],
                        presentation: 'grouped',
                    },
                ],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'group-main',
            },
        }));

        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        startConcurrentSessionCacheSync();

        await flushConcurrentCacheStartup();

        const initial = (storage.getState() as any).machineListByServerId?.['server-b'] ?? [];
        expect(initial.map((m: any) => m.id).sort()).toEqual(['machine-1', 'machine-2']);

        // Trigger periodic refresh (default is 5 minutes).
        await flushConcurrentCachePeriodicRefresh();

        const after = (storage.getState() as any).machineListByServerId?.['server-b'] ?? [];
        expect(after.map((m: any) => m.id)).toEqual(['machine-1']);
        expect(after[0]?.seq).toBe(2);

        stopConcurrentSessionCacheSync();
    });

    it('keeps concurrent session cache updates isolated per server when two servers refresh concurrently', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        mockReachabilityOnline();

        const fakeSocketB = createSocketStub();
        const fakeSocketC = createSocketStub();
        ioSpy.mockImplementation((serverUrl: string) => {
            if (serverUrl === 'https://stack-b.example.test') return fakeSocketB;
            if (serverUrl === 'https://stack-c.example.test') return fakeSocketC;
            return createSocketStub();
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
            isLegacyAuthCredentials: (credentials: any) => Boolean(credentials && typeof credentials === 'object' && typeof credentials.secret === 'string'),
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
                serverSelectionGroups: [
                    {
                        id: 'group-main',
                        name: 'Main',
                        serverIds: ['server-a', 'server-b', 'server-c'],
                        presentation: 'grouped',
                    },
                ],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'group-main',
            },
        }));

        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        startConcurrentSessionCacheSync();
        await flushConcurrentCacheStartup(3);

        const cacheByServer = storage.getState().sessionListViewDataByServerId;
        const serverBItems = cacheByServer['server-b'] ?? [];
        const serverCItems = cacheByServer['server-c'] ?? [];

        const serverBSessionIds = serverBItems
            .filter((item: any) => item?.type === 'session' && item?.section === 'active')
            .map((item: any) => item.session.id);
        const serverCSessionIds = serverCItems
            .filter((item: any) => item?.type === 'session' && item?.section === 'active')
            .map((item: any) => item.session.id);

        expect(serverBSessionIds).toContain('session-b');
        expect(serverBSessionIds).not.toContain('session-c');
        expect(serverCSessionIds).toContain('session-c');
        expect(serverCSessionIds).not.toContain('session-b');

        const machinesByServer = (storage.getState() as any).machineListByServerId as undefined | Record<string, any>;
        expect(machinesByServer).toBeDefined();
        expect(Array.isArray(machinesByServer?.['server-b'])).toBe(true);
        expect(Array.isArray(machinesByServer?.['server-c'])).toBe(true);
        expect((machinesByServer?.['server-b'] ?? []).map((m: any) => m.id)).toContain('machine-b');
        expect((machinesByServer?.['server-c'] ?? []).map((m: any) => m.id)).toContain('machine-c');

        stopConcurrentSessionCacheSync();
    });

    it('scopes same-url concurrent cache refreshes by server id when alternate profiles share credentials storage', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        mockReachabilityOnline();

        const sharedServerUrl = 'https://shared-stack.example.test';
        const fakeSocketB = createSocketStub();
        const fakeSocketC = createSocketStub();
        ioSpy.mockImplementation((serverUrl: string, options?: { auth?: { token?: string } }) => {
            if (serverUrl !== sharedServerUrl) {
                return createSocketStub();
            }
            if (options?.auth?.token === 'token-b') return fakeSocketB;
            if (options?.auth?.token === 'token-c') return fakeSocketC;
            return createSocketStub();
        });

        getCredentialsForServerUrlSpy.mockImplementation(async (
            serverUrl: string,
            options?: { serverId?: string | null },
        ) => {
            if (serverUrl !== sharedServerUrl) {
                return null;
            }
            if (options?.serverId === 'server-b') {
                return { token: 'token-b', secret: 'secret-b' };
            }
            if (options?.serverId === 'server-c') {
                return { token: 'token-c', secret: 'secret-c' };
            }
            return { token: 'token-c', secret: 'secret-c' };
        });

        listServerProfilesSpy.mockReturnValue([
            { id: 'server-a', serverUrl: 'https://stack-a.example.test', name: 'Server A' },
            { id: 'server-b', serverUrl: sharedServerUrl, name: 'Server B' },
            { id: 'server-c', serverUrl: sharedServerUrl, name: 'Server C' },
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
            isLegacyAuthCredentials: (credentials: any) => Boolean(credentials && typeof credentials === 'object' && typeof credentials.secret === 'string'),
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
                serverSelectionGroups: [
                    {
                        id: 'group-main',
                        name: 'Main',
                        serverIds: ['server-a', 'server-b', 'server-c'],
                        presentation: 'grouped',
                    },
                ],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'group-main',
            },
        }));

        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        startConcurrentSessionCacheSync();
        await flushConcurrentCacheStartup(3);

        expect(getCredentialsForServerUrlSpy).toHaveBeenCalledWith(sharedServerUrl, { serverId: 'server-b' });
        expect(getCredentialsForServerUrlSpy).toHaveBeenCalledWith(sharedServerUrl, { serverId: 'server-c' });

        const cacheByServer = storage.getState().sessionListViewDataByServerId;
        const serverBSessionIds = (cacheByServer['server-b'] ?? [])
            .filter((item: any) => item?.type === 'session' && item?.section === 'active')
            .map((item: any) => item.session.id);
        const serverCSessionIds = (cacheByServer['server-c'] ?? [])
            .filter((item: any) => item?.type === 'session' && item?.section === 'active')
            .map((item: any) => item.session.id);

        expect(serverBSessionIds).toContain('session-b');
        expect(serverBSessionIds).not.toContain('session-c');
        expect(serverCSessionIds).toContain('session-c');
        expect(serverCSessionIds).not.toContain('session-b');

        const machinesByServer = storage.getState().machineListByServerId;
        expect((machinesByServer['server-b'] ?? []).map((machine: any) => machine.id)).toEqual(['machine-b']);
        expect((machinesByServer['server-c'] ?? []).map((machine: any) => machine.id)).toEqual(['machine-c']);

        stopConcurrentSessionCacheSync();
    });

    it('clears stale non-active server cache entries when a server is removed from the concurrent selection', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        mockReachabilityOnline();

        const fakeSocketB = createSocketStub();
        const fakeSocketC = createSocketStub();
        ioSpy.mockImplementation((serverUrl: string) => {
            if (serverUrl === 'https://stack-b.example.test') return fakeSocketB;
            if (serverUrl === 'https://stack-c.example.test') return fakeSocketC;
            return createSocketStub();
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
            isLegacyAuthCredentials: (credentials: any) =>
                Boolean(credentials && typeof credentials === 'object' && typeof credentials.secret === 'string'),
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
                serverSelectionGroups: [
                    {
                        id: 'group-main',
                        name: 'Main',
                        serverIds: ['server-a', 'server-b', 'server-c'],
                        presentation: 'grouped',
                    },
                ],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'group-main',
            },
        }));

        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        startConcurrentSessionCacheSync();
        await flushConcurrentCacheStartup(3);

        expect(Object.keys(storage.getState().sessionListViewDataByServerId)).toEqual(
            expect.arrayContaining(['server-b', 'server-c']),
        );

        storage.setState((state) => ({
            ...state,
            settings: {
                ...state.settings,
                serverSelectionGroups: [
                    {
                        id: 'group-main',
                        name: 'Main',
                        serverIds: ['server-a', 'server-b'],
                        presentation: 'grouped',
                    },
                ],
            },
        }));

        await flushConcurrentCacheStartup();

        expect(storage.getState().sessionListViewDataByServerId['server-c']).toBeUndefined();
        expect((storage.getState() as any).machineListByServerId?.['server-c']).toBeUndefined();

        stopConcurrentSessionCacheSync();
    });

});
