import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerProfilesModuleMock } from '@/dev/testkit';

const ioSpy = vi.fn();
const getCredentialsForServerUrlSpy = vi.fn();
const listServerProfilesSpy = vi.fn();
const getActiveServerSnapshotSpy = vi.fn();
const runtimeFetchSpy = vi.fn();
const invalidateCachedTransferRoutesForServerSpy = vi.fn();
const fetchAndApplySessionsSpy = vi.hoisted(() =>
    vi.fn<(params: { applySessions: (sessions: unknown[]) => void }) => Promise<void>>(async ({ applySessions }) => {
        applySessions([]);
    }),
);
const fetchAndApplyMachinesSpy = vi.hoisted(() =>
    vi.fn<(params: { applyMachines: (machines: unknown[]) => void }) => Promise<void>>(async ({ applyMachines }) => {
        applyMachines([]);
    }),
);

type SocketEventHandler = (...args: unknown[]) => void;

let activeServerListener: ((snapshot: { serverId: string; serverUrl: string; kind?: string; generation: number }) => void) | null = null;

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
        emitServerEvent: (event: string, payload: unknown) => {
            for (const listener of listeners.get(event) ?? []) {
                listener(payload);
            }
        },
    };
    return socket;
}

function mockConcurrentSessionCacheDeps() {
    vi.doMock('socket.io-client', () => ({
        io: (...args: unknown[]) => ioSpy(...args),
    }));
    vi.doMock('@/auth/storage/tokenStorage', () => ({
        TokenStorage: {
            getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsForServerUrlSpy(...args),
        },
        isLegacyAuthCredentials: (credentials: unknown) =>
            Boolean(credentials && typeof credentials === 'object' && typeof (credentials as { secret?: unknown }).secret === 'string'),
    }));
    vi.doMock('@/sync/domains/server/serverProfiles', () => createServerProfilesModuleMock({
        listServerProfiles: () => listServerProfilesSpy(),
    }));
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => getActiveServerSnapshotSpy(),
        subscribeActiveServer: (listener: (snapshot: { serverId: string; serverUrl: string; kind?: string; generation: number }) => void) => {
            activeServerListener = listener;
            return () => {
                if (activeServerListener === listener) {
                    activeServerListener = null;
                }
            };
        },
    }));
    vi.doMock('@/sync/domains/transfers/runtime/transferRouteCache', () => ({
        invalidateCachedTransferRoutesForServer: (...args: unknown[]) => invalidateCachedTransferRoutesForServerSpy(...args),
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
        fetchAndApplySessions: (params: { applySessions: (sessions: unknown[]) => void }) => fetchAndApplySessionsSpy(params),
    }));
    vi.doMock('@/sync/engine/machines/syncMachines', () => ({
        fetchAndApplyMachines: (params: { applyMachines: (machines: unknown[]) => void }) => fetchAndApplyMachinesSpy(params),
    }));
    vi.doMock('@/log', () => ({
        log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('@/utils/system/runtimeFetch', () => ({
        runtimeFetch: (...args: unknown[]) => runtimeFetchSpy(...args),
    }));
}

async function configureConcurrentSelection(): Promise<void> {
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
}

async function startConcurrentCacheAndWaitForReconcile(): Promise<{
    stopConcurrentSessionCacheSync: () => void;
}> {
    const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
    startConcurrentSessionCacheSync();
    await vi.waitFor(() => {
        expect(ioSpy).toHaveBeenCalled();
    });
    return { stopConcurrentSessionCacheSync };
}

beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    ioSpy.mockReset();
    getCredentialsForServerUrlSpy.mockReset();
    listServerProfilesSpy.mockReset();
    getActiveServerSnapshotSpy.mockReset();
    runtimeFetchSpy.mockReset();
    invalidateCachedTransferRoutesForServerSpy.mockReset();
    fetchAndApplySessionsSpy.mockReset();
    fetchAndApplySessionsSpy.mockImplementation(async ({ applySessions }: { applySessions: (sessions: unknown[]) => void }) => {
        applySessions([]);
    });
    fetchAndApplyMachinesSpy.mockReset();
    fetchAndApplyMachinesSpy.mockImplementation(async ({ applyMachines }: { applyMachines: (machines: unknown[]) => void }) => {
        applyMachines([]);
    });
    process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
    activeServerListener = null;
});

afterEach(async () => {
    vi.useRealTimers();
    try {
        const { setServerReachabilityNetworkAllowed, resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        setServerReachabilityNetworkAllowed(true);
        await resetServerReachabilitySupervisors();
    } catch {
        // ignore
    }
    delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
});

describe('concurrent session cache supervised sockets', () => {
    it('does not connect sockets while network is disallowed, then connects when network is re-enabled', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));

        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });
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

        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();
        const { setServerReachabilityNetworkAllowed } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        setServerReachabilityNetworkAllowed(false);

        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        startConcurrentSessionCacheSync();

        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(ioSpy).toHaveBeenCalledTimes(0);
        expect(fakeSocket.connect).toHaveBeenCalledTimes(0);

        setServerReachabilityNetworkAllowed(true);

        await vi.waitFor(() => {
            expect(ioSpy).toHaveBeenCalled();
        });

        stopConcurrentSessionCacheSync();
    });

    it('opens non-active server sockets with server-scoped credentials', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
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

        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();

        expect(ioSpy).toHaveBeenCalledTimes(1);
        expect(ioSpy).toHaveBeenCalledWith(
            'https://stack-b.example.test',
            expect.objectContaining({
                path: '/v1/updates/',
                auth: expect.objectContaining({
                    token: 'token-b',
                    clientType: 'user-scoped',
                }),
                reconnection: false,
                autoConnect: false,
            }),
        );
        expect(fakeSocket.connect).toHaveBeenCalledTimes(1);

        stopConcurrentSessionCacheSync();
    });

    it('invalidates cached transfer routes when the active server generation changes', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });
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

        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();

        expect(activeServerListener).toBeTypeOf('function');
        activeServerListener?.({
            serverId: 'server-a',
            serverUrl: 'https://stack-a.example.test',
            kind: 'stack',
            generation: 2,
        });

        expect(invalidateCachedTransferRoutesForServerSpy).toHaveBeenCalledWith({ serverId: 'server-a' });

        stopConcurrentSessionCacheSync();
    });

    it('invalidates both previous and next server transfer caches when the active server id changes', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });
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

        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();

        expect(activeServerListener).toBeTypeOf('function');
        activeServerListener?.({
            serverId: 'server-b',
            serverUrl: 'https://stack-b.example.test',
            kind: 'stack',
            generation: 1,
        });

        expect(invalidateCachedTransferRoutesForServerSpy).toHaveBeenNthCalledWith(1, { serverId: 'server-a' });
        expect(invalidateCachedTransferRoutesForServerSpy).toHaveBeenNthCalledWith(2, { serverId: 'server-b' });

        stopConcurrentSessionCacheSync();
    });

    it('subscribes to machine updates without using socket.onAny', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });
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

        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();

        expect(fakeSocket.onAny).not.toHaveBeenCalled();
        expect(fakeSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(fakeSocket.on).toHaveBeenCalledWith('update', expect.any(Function));

        stopConcurrentSessionCacheSync();
    });

    it('refreshes the remote machine cache when a machine update arrives on the concurrent socket', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });
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

        let machineRefreshCount = 0;
        fetchAndApplyMachinesSpy.mockImplementation(async ({ applyMachines }: { applyMachines: (machines: unknown[]) => void }) => {
            machineRefreshCount += 1;
            if (machineRefreshCount === 1) {
                applyMachines([]);
                return;
            }

            applyMachines([{
                id: 'machine-1',
                seq: 2,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                revokedAt: null,
                metadata: null,
                metadataVersion: 0,
                daemonState: {
                    transfer: {
                        supported: { import: true, export: true },
                        listenerClasses: {
                            loopback_http: { enabled: true, configured: true, active: true },
                            lan_http: { enabled: false, configured: false, active: false },
                            tailscale_serve_https: { enabled: false, configured: false, active: false, available: false },
                        },
                        lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
                    },
                },
                daemonStateVersion: 2,
            }]);
        });

        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();

        await vi.waitFor(() => {
            expect(machineRefreshCount).toBeGreaterThanOrEqual(1);
        });

        fakeSocket.emitServerEvent('update', {
            id: 'update-1',
            seq: 10,
            createdAt: 10,
            body: {
                t: 'update-machine',
                machineId: 'machine-1',
                daemonState: { value: 'encrypted', version: 2 },
            },
        });

        await new Promise<void>((resolve) => setTimeout(resolve, 700));

        const { storage } = await import('@/sync/domains/state/storageStore');
        await vi.waitFor(() => {
            expect(machineRefreshCount).toBeGreaterThanOrEqual(2);
            expect(storage.getState().machineListByServerId['server-b']?.[0]?.daemonState?.transfer?.listenerClasses?.loopback_http?.active).toBe(true);
        });

        stopConcurrentSessionCacheSync();
    });

    it('uses supervised sockets without built-in socket.io reconnect loops', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });
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

        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();

        const opts = ioSpy.mock.calls[0]?.[1] as { reconnection?: boolean; autoConnect?: boolean } | undefined;
        expect(opts?.reconnection).toBe(false);
        expect(opts?.autoConnect).toBe(false);
        expect(fakeSocket.connect).toHaveBeenCalledTimes(1);

        stopConcurrentSessionCacheSync();
        await vi.waitFor(() => {
            expect(fakeSocket.disconnect).toHaveBeenCalled();
            expect(fakeSocket.removeAllListeners).toHaveBeenCalled();
        });
    });
});
