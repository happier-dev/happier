import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSocketIoManagerBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

import {
    createServerProfilesModuleMock,
    createSessionListRenderableSessionFixture,
    createTokenStorageModuleMock,
} from '@/dev/testkit';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { HomeCredentialMutationEvent } from '@/auth/storage/tokenStorage';

// Prepare the real graph before per-case module resets and transport fixtures.
installDisconnectedServerSocketBoundary();
const initialSync = await loadSyncSingletonForTests();
initialSync.dispose();

const ioSpy = vi.fn();
const getCredentialsForServerUrlSpy = vi.fn();
const listServerProfilesSpy = vi.fn();
const getActiveServerSnapshotSpy = vi.fn();
const runtimeFetchSpy = vi.fn();
const invalidateCachedTransferRoutesForServerSpy = vi.fn();
const scheduleMachineListDisplayWarmCacheSaveSpy = vi.fn();
const schedulePushTokenReconciliationSpy = vi.fn();
const invalidateCachedTransferRoutesForMachineSpy = vi.fn<(
    input: Readonly<{
        serverId?: string | null;
        remoteMachineId: string;
    }>,
) => void>();
type SnapshotRequest = (path: string, init: RequestInit) => Promise<Response>;
type SessionSnapshotParams = {
    applySessions: (sessions: unknown[]) => void;
    request?: SnapshotRequest;
    sessionListCursor?: string | null;
    sessionListAttentionCursor?: string | null;
};
type SessionSnapshotResult = Readonly<{
    sessionIds: string[];
    nextCursor: string | null;
    hasNext: boolean;
    attentionNextCursor: string | null;
    attentionHasNext: boolean;
    current: boolean;
    source: 'v2' | 'v1';
}>;
const completeSessionSnapshotResult = (): SessionSnapshotResult => ({
    sessionIds: [],
    nextCursor: null,
    hasNext: false,
    attentionNextCursor: null,
    attentionHasNext: false,
    current: true,
    source: 'v2',
});
const fetchAndApplySessionsSpy = vi.hoisted(() =>
    vi.fn<(params: SessionSnapshotParams) => Promise<SessionSnapshotResult | void>>(async ({ applySessions }) => {
        applySessions([]);
    }),
);
const fetchAndApplyMachinesSpy = vi.hoisted(() =>
    vi.fn<(params: { applyMachines: (machines: unknown[]) => void }) => Promise<void>>(async ({ applyMachines }) => {
        applyMachines([]);
    }),
);

type SocketEventHandler = (...args: unknown[]) => void;

function createSocketStub() {
    const listeners = new Map<string, Set<SocketEventHandler>>();
    const socket = {
        io: createSocketIoManagerBoundaryStub(),
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
        emit: vi.fn(),
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

function onlineState() {
    return {
        phase: 'online' as const,
        reason: 'initial_connect',
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    };
}

function mockConcurrentSessionCacheRuntimeDeps() {
    vi.doMock('@/sync/engine/account/syncAccount', () => ({
        schedulePushTokenReconciliation: () => schedulePushTokenReconciliationSpy(),
        startPushTokenReconciliation: vi.fn(),
        stopPushTokenReconciliation: vi.fn(),
    }));
    vi.doMock('socket.io-client', () => ({
        io: (...args: unknown[]) => ioSpy(...args),
    }));
    vi.doMock('@/sync/domains/server/serverProfiles', () => createServerProfilesModuleMock({
        listServerProfiles: () => listServerProfilesSpy(),
        overrides: {
            loadHomeViewState: () => null,
            subscribeHomeViewState: () => () => {},
            subscribeServerProfiles: () => () => {},
            // Real TokenStorage resolves exact-target credential scopes through these.
            getActiveServerId: () => 'server-a',
            getActiveServerUrl: () => 'https://stack-a.example.test',
        },
    }));
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => getActiveServerSnapshotSpy(),
    }));
    vi.doMock('@/sync/domains/transfers/runtime/transferRouteCache', () => ({
        invalidateCachedTransferRoutesForServer: (...args: unknown[]) => invalidateCachedTransferRoutesForServerSpy(...args),
        invalidateCachedTransferRoutesForMachine: (
            input: Readonly<{
                serverId?: string | null;
                remoteMachineId: string;
            }>,
        ) => invalidateCachedTransferRoutesForMachineSpy(input),
    }));
    vi.doMock('@/sync/domains/state/machineDisplayWarmCacheWriter', () => ({
        scheduleMachineListDisplayWarmCacheSave: (...args: unknown[]) => scheduleMachineListDisplayWarmCacheSaveSpy(...args),
    }));
    vi.doMock('@/sync/encryption/encryption', () => ({
        Encryption: {
            create: async () => ({}) as unknown,
        },
    }));
    vi.doMock('@/sync/engine/sessions/sessionSnapshot', () => ({
        fetchAndApplySessions: async (params: SessionSnapshotParams) => (
            await fetchAndApplySessionsSpy(params) ?? completeSessionSnapshotResult()
        ),
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

function mockTokenStorageCredentialReads() {
    vi.doMock('@/auth/storage/tokenStorage', async (importOriginal) => await createTokenStorageModuleMock({
        importOriginal: async <T,>() => await importOriginal<T>(),
        tokenStorage: {
            getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsForServerUrlSpy(...args),
        },
    }));
}

function mockConcurrentSessionCacheDeps() {
    mockConcurrentSessionCacheRuntimeDeps();
    mockTokenStorageCredentialReads();
}

function mockRealTokenStorageDeviceBoundaries() {
    vi.doUnmock('@/auth/storage/tokenStorage');
    // The real credential storage owner runs; only the genuine device/secure-store
    // boundaries are stood in for (web Platform + in-memory localStorage).
    vi.doMock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'web' } });
    });
    vi.doMock('expo-secure-store', () => ({}));
    vi.doMock('@react-native-async-storage/async-storage', () => ({
        default: {
            getItem: vi.fn(async () => null),
            setItem: vi.fn(async () => {}),
            removeItem: vi.fn(async () => {}),
        },
    }));
}

async function configureConcurrentSelection(): Promise<void> {
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('./appliedActiveServerRuntime');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
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
    invalidateCachedTransferRoutesForMachineSpy.mockReset();
    scheduleMachineListDisplayWarmCacheSaveSpy.mockReset();
    schedulePushTokenReconciliationSpy.mockReset();
    fetchAndApplySessionsSpy.mockReset();
    fetchAndApplySessionsSpy.mockImplementation(async ({ applySessions }: SessionSnapshotParams) => {
        applySessions([]);
    });
    fetchAndApplyMachinesSpy.mockReset();
    fetchAndApplyMachinesSpy.mockImplementation(async ({ applyMachines }: { applyMachines: (machines: unknown[]) => void }) => {
        applyMachines([]);
    });
    process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
});

afterEach(async () => {
    vi.useRealTimers();
    try {
        const { stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        stopConcurrentSessionCacheSync();
        const { setServerReachabilityNetworkAllowed, resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        setServerReachabilityNetworkAllowed(true);
        await resetServerReachabilitySupervisors();
    } catch {
        // ignore
    }
    delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
});

describe('concurrent session cache supervised sockets', () => {
    it('retains an open attention frontier across bounded refresh pumps and publishes ready only after it closes', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: new Headers(),
        }));
        ioSpy.mockReturnValue(createSocketStub());
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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
        let finishAttentionContinuation!: () => void;
        fetchAndApplySessionsSpy
            .mockResolvedValueOnce({
                ...completeSessionSnapshotResult(),
                attentionNextCursor: 'attention-100',
                attentionHasNext: true,
            })
            .mockImplementationOnce(async () => {
                await new Promise<void>((resolve) => { finishAttentionContinuation = resolve; });
                return {
                    ...completeSessionSnapshotResult(),
                    sessionIds: ['attention-page-101'],
                };
            });
        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();
        const { storage } = await import('@/sync/domains/state/storageStore');

        await vi.waitFor(() => expect(fetchAndApplySessionsSpy).toHaveBeenCalledTimes(2), { timeout: 2_000 });
        expect(fetchAndApplySessionsSpy.mock.calls[0]?.[0]).toMatchObject({
            sessionListCursor: null,
            sessionListAttentionCursor: null,
        });
        expect(storage.getState().concurrentSessionListCacheByServerId['server-b']?.listObservation?.phase)
            .not.toBe('ready');
        expect(fetchAndApplySessionsSpy.mock.calls[1]?.[0]).toMatchObject({
            sessionListCursor: null,
            sessionListAttentionCursor: 'attention-100',
        });
        finishAttentionContinuation();
        await vi.waitFor(() => {
            expect(storage.getState().concurrentSessionListCacheByServerId['server-b']?.listObservation?.phase)
                .toBe('ready');
        });

        stopConcurrentSessionCacheSync();
    });

    it('aborts an owned secondary snapshot request before releasing the managed transport', async () => {
        let snapshotSignal: AbortSignal | null = null;
        runtimeFetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
            if (!url.endsWith('/v1/test-secondary-snapshot')) {
                return new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() });
            }
            snapshotSignal = init?.signal ?? null;
            return await new Promise<Response>((_resolve, reject) => {
                snapshotSignal?.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'));
                }, { once: true });
            });
        });
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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
        fetchAndApplySessionsSpy.mockImplementation(async ({ request }: SessionSnapshotParams) => {
            await request?.('/v1/test-secondary-snapshot', { method: 'GET' });
        });
        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();
        await vi.waitFor(() => expect(snapshotSignal).not.toBeNull());
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.setState((state) => ({
            ...state,
            machineListStatusByServerId: {
                ...state.machineListStatusByServerId,
                'server-b': 'idle',
            },
        }));

        stopConcurrentSessionCacheSync();

        expect((snapshotSignal as AbortSignal | null)?.aborted).toBe(true);
        expect(storage.getState().machineListStatusByServerId['server-b']).toBe('idle');
    });

    it('projects an authenticated secondary HTTP rejection through the exact-token reachability owner', async () => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'secondary-account' })).toString('base64url')}.signature`;
        runtimeFetchSpy.mockImplementation(async (url: string) => new Response(
            JSON.stringify({ ok: !url.endsWith('/v1/test-secondary-auth') }),
            { status: url.endsWith('/v1/test-secondary-auth') ? 401 : 200, headers: new Headers() },
        ));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token, secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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
        fetchAndApplySessionsSpy.mockImplementation(async ({ request }: SessionSnapshotParams) => {
            await request?.('/v1/test-secondary-auth', { method: 'GET' });
        });
        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();
        const { storage } = await import('@/sync/domains/state/storageStore');
        const reachability = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');

        await vi.waitFor(() => {
            expect(reachability.peekServerReachabilityState('https://stack-b.example.test', token)?.phase).toBe('auth_failed');
            expect(storage.getState().machineListStatusByServerId['server-b']).toBe('signedOut');
        });
        expect(reachability.peekServerReachabilityState('https://stack-b.example.test', 'some-other-token')).toBeNull();

        stopConcurrentSessionCacheSync();
    });

    it('marks a cold secondary Home offline even when it has no cached machine rows', async () => {
        runtimeFetchSpy.mockRejectedValue(new Error('secondary Home offline'));
        ioSpy.mockImplementation(() => createSocketStub());
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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
        const reachability = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await reachability.startServerReachabilitySupervisor({
            serverUrl: 'https://stack-b.example.test',
            token: 'token-b',
        });
        expect(reachability.peekServerReachabilityState('https://stack-b.example.test', 'token-b')?.phase).toBe('offline');
        await configureConcurrentSelection();

        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        startConcurrentSessionCacheSync();
        const { storage } = await import('@/sync/domains/state/storageStore');

        await vi.waitFor(() => {
            expect(storage.getState().machineListStatusByServerId['server-b']).toBe('error');
        });
        expect(storage.getState().machineListByServerId['server-b']).toBeNull();
        expect(ioSpy).not.toHaveBeenCalled();

        stopConcurrentSessionCacheSync();
    });

    it('consumes the reachability pool\'s already-online initial state when constructing a secondary Home transport', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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

        // Pre-warm the shared reachability entry for Home B so the pool is already
        // online BEFORE the concurrent cache constructs its managed entry.
        const {
            peekServerReachabilityState,
            waitForServerReachable,
        } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await waitForServerReachable({ serverUrl: 'https://stack-b.example.test', token: 'token-b', timeoutMs: 5_000 });
        await vi.waitFor(() => {
            expect(peekServerReachabilityState('https://stack-b.example.test')?.phase).toBe('online');
        });

        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();

        // The pool synchronously replays its current state to every new subscriber; the
        // managed entry must consume that initial online state and start its transport
        // without waiting for any further pool event.
        expect(ioSpy).toHaveBeenCalledTimes(1);
        expect(ioSpy).toHaveBeenCalledWith('https://stack-b.example.test', expect.anything());
        expect(fakeSocket.connect).toHaveBeenCalledTimes(1);

        stopConcurrentSessionCacheSync();
    });

    it('publishes the whole observation lifecycle and marks an online secondary Home stale when its Session-list refresh fails', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: new Headers(),
        }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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
        fetchAndApplySessionsSpy
            .mockImplementationOnce(async ({ applySessions }: SessionSnapshotParams) => applySessions([]))
            .mockRejectedValueOnce(new Error('secondary list unavailable'));
        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { storage } = await import('@/sync/domains/state/storageStore');
        // Every phase this Home publishes, in order. A surface reads currentness only from this
        // fact, so an unobserved Home must say `loading`, a retained one `refreshing`, and a
        // failed attempt `error` — never silence that reads as "still current".
        const observedPhases: string[] = [];
        const unsubscribeObservation = storage.subscribe((state) => {
            const phase = state.concurrentSessionListCacheByServerId['server-b']?.listObservation?.phase;
            if (phase && observedPhases[observedPhases.length - 1] !== phase) observedPhases.push(phase);
        });
        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();

        await vi.waitFor(() => {
            expect(storage.getState().concurrentSessionListCacheByServerId['server-b']?.listObservation?.phase)
                .toBe('ready');
        });
        // A Home nothing has observed yet announces its first attempt as `loading`, never as
        // silence that reads as current.
        expect(observedPhases.slice(0, 2)).toEqual(['loading', 'ready']);
        const firstSuccessAt = storage.getState()
            .concurrentSessionListCacheByServerId['server-b']?.listObservation?.lastSuccessAt;
        expect(firstSuccessAt).toEqual(expect.any(Number));

        fakeSocket.emitServerEvent('update', { body: { t: 'update-session' } });

        await vi.waitFor(() => {
            expect(storage.getState().concurrentSessionListCacheByServerId['server-b']?.listObservation)
                .toEqual({ phase: 'error', lastSuccessAt: firstSuccessAt });
        });
        // The retained rows were observed once, so the failed refresh announces itself as a
        // refresh of known rows rather than a first load, and `loading` never returns.
        expect(observedPhases.slice(-2)).toEqual(['refreshing', 'error']);
        expect(observedPhases.slice(1)).not.toContain('loading');

        unsubscribeObservation();
        stopConcurrentSessionCacheSync();
    });

    it('keeps a Session list observed by the failing attempt current instead of publishing its own error', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: new Headers(),
        }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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
        // The production list path applies its rows during the Session fetch, before the machine
        // inventory runs, so this attempt really did observe the list.
        fetchAndApplySessionsSpy.mockImplementation(async (
            { applySessionListRenderables }: SessionSnapshotParams & {
                applySessionListRenderables?: (rows: unknown[]) => void;
            },
        ) => {
            applySessionListRenderables?.([createSessionListRenderableSessionFixture({ id: 'session-b' })]);
        });
        let machineRefresh = 0;
        fetchAndApplyMachinesSpy.mockImplementation(async ({ applyMachines }: { applyMachines: (machines: unknown[]) => void }) => {
            machineRefresh += 1;
            if (machineRefresh === 1) {
                applyMachines([]);
                return;
            }
            throw new Error('machine refresh failed');
        });
        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();
        const { storage } = await import('@/sync/domains/state/storageStore');

        await vi.waitFor(() => {
            expect(storage.getState().concurrentSessionListCacheByServerId['server-b']?.listObservation?.phase)
                .toBe('ready');
        });

        fakeSocket.emitServerEvent('update', { body: { t: 'update-machine' } });
        await vi.waitFor(() => expect(machineRefresh).toBeGreaterThanOrEqual(2), { timeout: 2_000 });

        // Machine staleness is not list staleness: the list success this same attempt produced is
        // more current than the attempt's rejection, so it is never downgraded to `error`.
        expect(storage.getState().machineListStatusByServerId['server-b']).toBe('error');
        expect(storage.getState().concurrentSessionListCacheByServerId['server-b']?.listObservation?.phase)
            .toBe('ready');

        stopConcurrentSessionCacheSync();
    });

    it('leaves the reachability owner\'s offline fact in place when the refresh it interrupted fails', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: new Headers(),
        }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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
        let failInterruptedRefresh: (() => void) | null = null;
        fetchAndApplySessionsSpy
            .mockImplementationOnce(async ({ applySessions }: SessionSnapshotParams) => applySessions([]))
            .mockImplementationOnce(async () => {
                await new Promise<void>((resolve) => {
                    failInterruptedRefresh = resolve;
                });
                throw new Error('secondary list unavailable');
            });
        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();
        const { storage } = await import('@/sync/domains/state/storageStore');
        const reachability = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');

        await vi.waitFor(() => {
            expect(storage.getState().concurrentSessionListCacheByServerId['server-b']?.listObservation?.phase)
                .toBe('ready');
        });

        fakeSocket.emitServerEvent('update', { body: { t: 'update-session' } });
        await vi.waitFor(() => expect(failInterruptedRefresh).not.toBeNull());

        reachability.reportServerUnreachable('https://stack-b.example.test', new Error('socket unreachable'));
        await vi.waitFor(() => {
            expect(storage.getState().concurrentSessionListCacheByServerId['server-b']?.listObservation?.phase)
                .toBe('offline');
        });

        // The machine cache is the one write this Home's failure path always performs, so
        // clearing it first makes the rejection observable instead of time-based.
        storage.setState((state) => ({
            ...state,
            machineListStatusByServerId: { ...state.machineListStatusByServerId, 'server-b': 'idle' },
        }));
        (failInterruptedRefresh as unknown as () => void)();
        await vi.waitFor(() => {
            expect(storage.getState().machineListStatusByServerId['server-b']).toBe('error');
        });
        // Reachability already answered this Home more recently than the request it cut off. A
        // late rejection must not relabel an offline Home as a reachable Home that failed.
        expect(storage.getState().concurrentSessionListCacheByServerId['server-b']?.listObservation?.phase)
            .toBe('offline');

        stopConcurrentSessionCacheSync();
    });

    it('keeps last-known secondary rows but marks their inventory stale while reachability is offline, then restores currentness without duplication', async () => {
        let reachable = true;
        runtimeFetchSpy.mockImplementation(async () => {
            if (!reachable) throw new Error('secondary Home offline');
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() });
        });
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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
        fetchAndApplySessionsSpy.mockImplementation(async ({ applySessions }: { applySessions: (sessions: unknown[]) => void }) => {
            applySessions([{
                id: 'session-b',
                seq: 1,
                createdAt: 1_000,
                updatedAt: 2_000,
                active: true,
                activeAt: 2_000,
                metadata: { machineId: 'machine-b', path: '/workspace/b', host: 'b-host' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            }]);
        });
        fetchAndApplyMachinesSpy.mockImplementation(async ({ applyMachines }: { applyMachines: (machines: unknown[]) => void }) => {
            applyMachines([{
                id: 'machine-b',
                seq: 1,
                createdAt: 1_000,
                updatedAt: 2_000,
                active: true,
                activeAt: 2_000,
                revokedAt: null,
                metadata: { host: 'b-host', homeDir: '/home/b' },
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
            }]);
        });
        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { resolveAllProfileMachineInventorySnapshots } = await import('@/sync/domains/machines/machineInventorySnapshots');
        const reachability = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');

        await vi.waitFor(() => {
            expect(storage.getState().machineListStatusByServerId['server-b']).toBe('idle');
            expect(storage.getState().sessionListRowsByServerId['server-b']?.['session-b']).toBeDefined();
            expect(storage.getState().concurrentSessionListCacheByServerId['server-b']?.listObservation?.phase).toBe('ready');
        });
        const currentRows = storage.getState().sessionListRowsByServerId['server-b'];
        const currentMachines = storage.getState().machineListByServerId['server-b'];
        schedulePushTokenReconciliationSpy.mockClear();

        reachable = false;
        reachability.reportServerUnreachable('https://stack-b.example.test', new Error('socket unreachable'));

        await vi.waitFor(() => {
            expect(storage.getState().machineListStatusByServerId['server-b']).toBe('error');
            expect(storage.getState().concurrentSessionListCacheByServerId['server-b']?.listObservation?.phase).toBe('offline');
        });
        expect(storage.getState().sessionListRowsByServerId['server-b']).toBe(currentRows);
        expect(storage.getState().machineListByServerId['server-b']).toBe(currentMachines);
        expect(resolveAllProfileMachineInventorySnapshots({
            profiles: [{
                id: 'server-b',
                name: 'Server B',
                serverUrl: 'https://stack-b.example.test',
                serverIdentityId: 'server-b',
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
            }],
            activeServerId: 'server-a',
            activeInventoryLoaded: true,
            activeMachines: [],
            machineListByServerId: storage.getState().machineListByServerId,
            machineListStatusByServerId: storage.getState().machineListStatusByServerId,
            accountId: 'focused-account',
            loadWarmEntries: () => ({}),
        })).toEqual([
            expect.objectContaining({ kind: 'resolved', observation: 'stale' }),
        ]);

        reachable = true;
        await reachability.invalidateServerReachabilitySupervisor({
            serverUrl: 'https://stack-b.example.test',
            token: 'token-b',
        });
        await vi.waitFor(() => {
            expect(storage.getState().machineListStatusByServerId['server-b']).toBe('idle');
            expect(storage.getState().concurrentSessionListCacheByServerId['server-b']?.listObservation?.phase).toBe('ready');
        });
        expect(schedulePushTokenReconciliationSpy).toHaveBeenCalledTimes(1);
        expect(Object.keys(storage.getState().sessionListRowsByServerId['server-b'] ?? {})).toEqual(['session-b']);
        expect(storage.getState().machineListByServerId['server-b']?.map((machine) => machine.id)).toEqual(['machine-b']);
        expect(scheduleMachineListDisplayWarmCacheSaveSpy).not.toHaveBeenCalled();

        stopConcurrentSessionCacheSync();
    });

    it('preserves the complete last-known snapshot and marks it stale when a machine refresh fails', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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
        fetchAndApplySessionsSpy.mockImplementation(async ({ applySessions }) => {
            applySessions([{
                id: 'session-b', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                metadata: { machineId: 'machine-b', path: '/workspace/b', host: 'b-host' },
                metadataVersion: 1, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0,
            }]);
        });
        let machineRefresh = 0;
        fetchAndApplyMachinesSpy.mockImplementation(async ({ applyMachines }) => {
            machineRefresh += 1;
            if (machineRefresh === 1) {
                applyMachines([{
                    id: 'machine-b', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                    revokedAt: null, metadata: { host: 'b-host' }, metadataVersion: 1,
                    daemonState: null, daemonStateVersion: 0,
                }]);
                return;
            }
            throw new Error('machine refresh failed');
        });
        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();
        const { storage } = await import('@/sync/domains/state/storageStore');
        await vi.waitFor(() => expect(storage.getState().machineListStatusByServerId['server-b']).toBe('idle'));
        const currentMachines = storage.getState().machineListByServerId['server-b'];
        const currentRows = storage.getState().sessionListRowsByServerId['server-b'];

        fakeSocket.emitServerEvent('update', { body: { t: 'update-machine' } });
        await vi.waitFor(() => expect(machineRefresh).toBeGreaterThanOrEqual(2), { timeout: 2_000 });

        expect(storage.getState().machineListStatusByServerId['server-b']).toBe('error');
        expect(storage.getState().machineListByServerId['server-b']).toBe(currentMachines);
        expect(storage.getState().sessionListRowsByServerId['server-b']).toBe(currentRows);

        stopConcurrentSessionCacheSync();
    });

    it('disposes a partially constructed managed entry so a later reconcile stays healthy', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        const firstSocket = createSocketStub();
        const secondSocket = createSocketStub();
        ioSpy.mockReturnValueOnce(firstSocket).mockImplementation(() => secondSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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

        let acquireCalls = 0;
        let networkAllowedListener: ((allowed: boolean) => void) | null = null;
        vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => ({
            ...await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>(),
            subscribeServerReachabilityNetworkAllowed: (listener: (allowed: boolean) => void) => {
                networkAllowedListener = listener;
                listener(true);
                return () => {
                    if (networkAllowedListener === listener) {
                        networkAllowedListener = null;
                    }
                };
            },
            subscribeServerReachabilityState: (_serverUrl: string, listener: (state: unknown) => void) => {
                listener(onlineState());
                return () => {};
            },
            acquireServerReachabilitySupervisor: async () => {
                acquireCalls += 1;
                if (acquireCalls === 1) throw new Error('acquisition failed after online replay');
                return { release: async () => {} };
            },
            reportServerUnreachable: () => {},
        }));

        await configureConcurrentSelection();
        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        startConcurrentSessionCacheSync();

        // The synchronous online replay builds and connects the first transport before
        // reachability acquisition fails. Construction rollback must dispose it exactly.
        await vi.waitFor(() => expect(ioSpy).toHaveBeenCalled());
        await vi.waitFor(() => {
            expect(firstSocket.disconnect).toHaveBeenCalled();
            expect(firstSocket.removeAllListeners).toHaveBeenCalled();
        });

        // Construction failures stay local. A later canonical lifecycle event
        // requests the retry rather than the entry growing its own retry owner.
        expect(networkAllowedListener).not.toBeNull();
        (networkAllowedListener as ((allowed: boolean) => void) | null)?.(true);
        await vi.waitFor(() => {
            expect(secondSocket.connect).toHaveBeenCalled();
        });

        stopConcurrentSessionCacheSync();
    });

    it('does not connect sockets while network is disallowed, then connects when network is re-enabled', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));

        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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
                return { token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' };
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
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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

        const { getAppliedActiveServerSnapshot, publishAppliedActiveServerSnapshot } = await import('./appliedActiveServerRuntime');
        publishAppliedActiveServerSnapshot({ ...getAppliedActiveServerSnapshot(), generation: 2 });

        expect(invalidateCachedTransferRoutesForServerSpy).toHaveBeenCalledWith({ serverId: 'server-a' });

        stopConcurrentSessionCacheSync();
    });

    it('invalidates both previous and next server transfer caches when the active server id changes', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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

        const { publishAppliedActiveServerSnapshot } = await import('./appliedActiveServerRuntime');
        publishAppliedActiveServerSnapshot({ serverId: 'server-b', serverUrl: 'https://stack-b.example.test', generation: 1 });

        expect(invalidateCachedTransferRoutesForServerSpy).toHaveBeenCalledWith({ serverId: 'server-a' });
        expect(invalidateCachedTransferRoutesForServerSpy).toHaveBeenCalledWith({ serverId: 'server-b' });

        stopConcurrentSessionCacheSync();
    });

    it('subscribes to update and ephemeral channels without using socket.onAny', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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
        expect(fakeSocket.on).toHaveBeenCalledWith('ephemeral', expect.any(Function));

        stopConcurrentSessionCacheSync();
    });


    it('feeds concurrent-server machine activity transitions to status-demand recovery', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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
        const {
            replaceExternalSessionStatusDemandViewport,
            resetExternalSessionStatusDemandCoordinatorForTests,
        } = await import('./externalSessions/externalSessionStatusDemandCoordinator');
        replaceExternalSessionStatusDemandViewport('concurrent-server-test', [{
            serverId: 'server-b',
            sessionId: 'session-1',
            machineId: 'machine-1',
            linkGeneration: 'generation-1',
            demand: 'visible',
        }]);

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();
        fakeSocket.emit.mockClear();

        fakeSocket.emitServerEvent('ephemeral', {
            type: 'machine-activity',
            id: 'machine-1',
            active: true,
            activeAt: 1_000,
        });
        fakeSocket.emitServerEvent('ephemeral', {
            type: 'machine-activity',
            id: 'machine-1',
            active: true,
            activeAt: 1_001,
        });

        expect(fakeSocket.emit).toHaveBeenCalledTimes(1);
        expect(fakeSocket.emit).toHaveBeenLastCalledWith(
            'external-session-status-demand-v1',
            expect.objectContaining({ revision: 3 }),
        );

        fakeSocket.emitServerEvent('ephemeral', {
            type: 'machine-activity',
            id: 'machine-1',
            active: false,
            activeAt: 1_002,
        });
        fakeSocket.emitServerEvent('ephemeral', {
            type: 'machine-activity',
            id: 'machine-1',
            active: true,
            activeAt: 1_003,
        });
        expect(fakeSocket.emit).toHaveBeenCalledTimes(2);
        expect(fakeSocket.emit).toHaveBeenLastCalledWith(
            'external-session-status-demand-v1',
            expect.objectContaining({ revision: 4 }),
        );

        stopConcurrentSessionCacheSync();
        resetExternalSessionStatusDemandCoordinatorForTests();
    });

    it('refreshes the remote machine cache when a machine update arrives on the concurrent socket', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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

    it('schedules push reconciliation without refreshing projections when a secondary account update arrives', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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
        await vi.waitFor(() => {
            expect(fetchAndApplySessionsSpy).toHaveBeenCalled();
            expect(fetchAndApplyMachinesSpy).toHaveBeenCalled();
        });
        const sessionRefreshCount = fetchAndApplySessionsSpy.mock.calls.length;
        const machineRefreshCount = fetchAndApplyMachinesSpy.mock.calls.length;
        schedulePushTokenReconciliationSpy.mockClear();

        const { subscribeHomeAccountChange } = await import('./homeAccountChange');
        const accountChangeObserver = vi.fn();
        const disposeObserver = subscribeHomeAccountChange(accountChangeObserver);

        fakeSocket.emitServerEvent('update', {
            id: 'update-account-1',
            seq: 11,
            createdAt: 11,
            body: {
                t: 'update-account',
                settings: { value: 'encrypted', version: 2 },
            },
        });

        expect(schedulePushTokenReconciliationSpy).toHaveBeenCalledTimes(1);
        // The wake is observable per exact Home, and stays content-free.
        expect(accountChangeObserver).toHaveBeenCalledTimes(1);
        expect(accountChangeObserver).toHaveBeenCalledWith({ serverId: 'server-b' });
        await new Promise<void>((resolve) => setTimeout(resolve, 700));
        expect(fetchAndApplySessionsSpy).toHaveBeenCalledTimes(sessionRefreshCount);
        expect(fetchAndApplyMachinesSpy).toHaveBeenCalledTimes(machineRefreshCount);

        disposeObserver();
        fakeSocket.emitServerEvent('update', {
            id: 'update-account-2',
            seq: 12,
            createdAt: 12,
            body: { t: 'update-account' },
        });
        expect(accountChangeObserver).toHaveBeenCalledTimes(1);

        stopConcurrentSessionCacheSync();
    });

    it('does not observe a non-account update as an Account-change wake', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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
        await vi.waitFor(() => {
            expect(fetchAndApplySessionsSpy).toHaveBeenCalled();
        });

        const { subscribeHomeAccountChange } = await import('./homeAccountChange');
        const accountChangeObserver = vi.fn();
        const disposeObserver = subscribeHomeAccountChange(accountChangeObserver);

        fakeSocket.emitServerEvent('update', { body: { t: 'update-machine' } });
        expect(accountChangeObserver).not.toHaveBeenCalled();

        disposeObserver();
        stopConcurrentSessionCacheSync();
    });

    it('conservatively invalidates exact-Home projections when a secondary socket reconnects', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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

        const { subscribeHomeAccountChange } = await import('./homeAccountChange');
        const accountChangeObserver = vi.fn();
        const disposeObserver = subscribeHomeAccountChange(accountChangeObserver);
        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();
        await vi.waitFor(() => expect(fakeSocket.connect).toHaveBeenCalledTimes(1));
        // Initial connection can miss writes after a reader's first snapshot too.
        expect(accountChangeObserver).toHaveBeenCalledTimes(1);
        expect(accountChangeObserver).toHaveBeenLastCalledWith({ serverId: 'server-b' });

        // A reconnect may have missed any number of content-free Account wakes.
        // The existing projection owners therefore receive one conservative
        // invalidation for this captured secondary Home, never the focused Home.
        fakeSocket.emitServerEvent('connect', undefined);
        expect(accountChangeObserver).toHaveBeenCalledTimes(2);
        expect(accountChangeObserver).toHaveBeenLastCalledWith({ serverId: 'server-b' });

        disposeObserver();
        stopConcurrentSessionCacheSync();
    });

    it('uses supervised sockets without built-in socket.io reconnect loops', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' });
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

describe('concurrent session cache exact-target credential reconciliation', () => {
    it('removes a running secondary Home transport promptly after global credential forget', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        ioSpy.mockImplementation(() => createSocketStub());
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

        mockRealTokenStorageDeviceBoundaries();
        mockConcurrentSessionCacheRuntimeDeps();
        await configureConcurrentSelection();
        const localStorageHandle = installLocalStorageMock();
        let stopConcurrentSessionCacheSync: (() => void) | null = null;
        let unsubscribeMutations: (() => void) | null = null;

        try {
            const { TokenStorage, subscribeHomeCredentialMutations } = await import('@/auth/storage/tokenStorage');
            await expect(TokenStorage.setCredentialsForServerUrl(
                'https://stack-a.example.test',
                { serverId: 'server-a' },
                { token: 'token-a', secret: 'secret-a' },
            )).resolves.toBe(true);
            await expect(TokenStorage.setCredentialsForServerUrl(
                'https://stack-b.example.test',
                { serverId: 'server-b' },
                { token: 'token-b', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' },
            )).resolves.toBe(true);
            const mutations: HomeCredentialMutationEvent[] = [];
            unsubscribeMutations = subscribeHomeCredentialMutations((event) => mutations.push(event));

            const cache = await import('./concurrentSessionCache');
            const { storage } = await import('@/sync/domains/state/storageStore');
            stopConcurrentSessionCacheSync = cache.stopConcurrentSessionCacheSync;
            cache.startConcurrentSessionCacheSync();
            await vi.waitFor(() => expect(ioSpy).toHaveBeenCalledTimes(1));
            const secondarySocket = ioSpy.mock.results[0]?.value as { disconnect: ReturnType<typeof vi.fn> };
            // Let all startup-triggered reconciles settle before exercising global forget.
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            expect(ioSpy).toHaveBeenCalledTimes(1);
            // Initial supervisor/socket convergence can legitimately issue an
            // intentional disconnect. Observe only the credential-removal edge.
            secondarySocket.disconnect.mockClear();

            await expect(TokenStorage.removeCredentials()).resolves.toBe(true);
            expect(mutations).toContainEqual({
                kind: 'credentials_removed',
                serverId: 'server-b',
                serverUrl: 'https://stack-b.example.test',
            });

            await vi.waitFor(() => {
                expect(secondarySocket.disconnect).toHaveBeenCalled();
                expect(storage.getState().machineListStatusByServerId?.['server-b']).toBe('signedOut');
            }, { timeout: 2_000 });
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
            expect(ioSpy).toHaveBeenCalledTimes(1);
            for (const call of ioSpy.mock.calls) {
                expect(call[0]).toBe('https://stack-b.example.test');
            }
        } finally {
            unsubscribeMutations?.();
            stopConcurrentSessionCacheSync?.();
            localStorageHandle.restore();
        }
    });

    it('replaces a managed secondary Home transport promptly after an exact-target credential replacement without touching the focused Home', async () => {
        // Both credentials belong to the same Account; only the transport token changes.
        const oldToken = `header.${Buffer.from(JSON.stringify({ sub: 'secondary-account', jti: 'old' })).toString('base64url')}.signature`;
        const newToken = `header.${Buffer.from(JSON.stringify({ sub: 'secondary-account', jti: 'new' })).toString('base64url')}.signature`;
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        ioSpy.mockImplementation(() => createSocketStub());
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

        mockRealTokenStorageDeviceBoundaries();
        mockConcurrentSessionCacheRuntimeDeps();
        await configureConcurrentSelection();
        const localStorageHandle = installLocalStorageMock();
        let unsubscribeMutations: (() => void) | null = null;
        let stopConcurrentSessionCacheSync: (() => void) | null = null;

        try {
            const { TokenStorage, subscribeHomeCredentialMutations } = await import('@/auth/storage/tokenStorage');
            const bTarget = { serverId: 'server-b' } as const;

            // Managed secondary Home B starts on the old token.
            await expect(TokenStorage.setCredentialsForServerUrl(
                'https://stack-b.example.test',
                bTarget,
                { token: oldToken, secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' },
            )).resolves.toBe(true);

            const cache = await import('./concurrentSessionCache');
            stopConcurrentSessionCacheSync = cache.stopConcurrentSessionCacheSync;
            const mutations: HomeCredentialMutationEvent[] = [];
            unsubscribeMutations = subscribeHomeCredentialMutations((event) => {
                mutations.push(event);
            });
            cache.startConcurrentSessionCacheSync();

            await vi.waitFor(() => {
                expect(ioSpy).toHaveBeenCalledTimes(1);
            });
            const oldSocket = ioSpy.mock.results[0]?.value as { disconnect: ReturnType<typeof vi.fn> };
            expect(ioSpy).toHaveBeenNthCalledWith(
                1,
                'https://stack-b.example.test',
                expect.objectContaining({
                    auth: expect.objectContaining({ token: oldToken }),
                }),
            );

            // Exact-target B credential replacement through the storage owner:
            // profiles, focus, and HomeView state are untouched by the write.
            await expect(TokenStorage.setCredentialsForServerUrl(
                'https://stack-b.example.test',
                bTarget,
                { token: newToken, secret: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI' },
            )).resolves.toBe(true);

            // Promptly (long before the 5-minute periodic reconcile), the stale B
            // transport stops and the replacement connects with the new token.
            await vi.waitFor(() => {
                expect(ioSpy).toHaveBeenCalledTimes(2);
            }, { timeout: 2_000 });
            expect(ioSpy).toHaveBeenNthCalledWith(
                2,
                'https://stack-b.example.test',
                expect.objectContaining({
                    auth: expect.objectContaining({ token: newToken }),
                }),
            );
            const newSocket = ioSpy.mock.results[1]?.value as { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
            await vi.waitFor(() => {
                expect(oldSocket.disconnect).toHaveBeenCalled();
            });
            expect(newSocket.connect).toHaveBeenCalled();

            // The focused Home A is not a concurrent target and keeps its own runtime.
            for (const call of ioSpy.mock.calls) {
                expect(call[0]).toBe('https://stack-b.example.test');
            }
            await expect(TokenStorage.getCredentialsForServerUrl('https://stack-a.example.test', { serverId: 'server-a' }))
                .resolves.toBeNull();
            expect(mutations).toEqual([
                { kind: 'credentials_set', serverId: 'server-b', serverUrl: 'https://stack-b.example.test' },
            ]);

            // Byte-identical re-writes must not churn the replacement transport.
            await expect(TokenStorage.setCredentialsForServerUrl(
                'https://stack-b.example.test',
                bTarget,
                { token: newToken, secret: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI' },
            )).resolves.toBe(true);
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 100);
            });
            expect(ioSpy).toHaveBeenCalledTimes(2);
            expect(newSocket.disconnect).not.toHaveBeenCalled();

        } finally {
            unsubscribeMutations?.();
            stopConcurrentSessionCacheSync?.();
            localStorageHandle.restore();
        }
    });

    it('emits no credential-mutation notification and restarts nothing when an exact-target credential write fails', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
        ioSpy.mockImplementation(() => createSocketStub());
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

        mockRealTokenStorageDeviceBoundaries();
        mockConcurrentSessionCacheRuntimeDeps();
        await configureConcurrentSelection();
        const localStorageHandle = installLocalStorageMock();
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        let unsubscribeMutations: (() => void) | null = null;
        let stopConcurrentSessionCacheSync: (() => void) | null = null;

        try {
            const { TokenStorage, subscribeHomeCredentialMutations } = await import('@/auth/storage/tokenStorage');
            const bTarget = { serverId: 'server-b' } as const;

            await expect(TokenStorage.setCredentialsForServerUrl(
                'https://stack-b.example.test',
                bTarget,
                { token: 'token-b-old', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' },
            )).resolves.toBe(true);

            const cache = await import('./concurrentSessionCache');
            stopConcurrentSessionCacheSync = cache.stopConcurrentSessionCacheSync;
            const mutations: HomeCredentialMutationEvent[] = [];
            unsubscribeMutations = subscribeHomeCredentialMutations((event) => {
                mutations.push(event);
            });
            cache.startConcurrentSessionCacheSync();

            await vi.waitFor(() => {
                expect(ioSpy).toHaveBeenCalledTimes(1);
            });
            const oldSocket = ioSpy.mock.results[0]?.value as { disconnect: ReturnType<typeof vi.fn> };

            // Genuine storage failure: the credential write cannot be persisted.
            localStorageHandle.setItemMock.mockImplementation((key: string, value: string) => {
                if (key.includes('auth_credentials__srv_')) {
                    throw new Error('storage write failed');
                }
                localStorageHandle.store.set(key, value);
            });

            await expect(TokenStorage.setCredentialsForServerUrl(
                'https://stack-b.example.test',
                bTarget,
                { token: 'token-b-new', secret: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI' },
            )).resolves.toBe(false);

            await new Promise<void>((resolve) => {
                setTimeout(resolve, 50);
            });
            expect(mutations).toEqual([]);
            expect(ioSpy).toHaveBeenCalledTimes(1);
            expect(oldSocket.disconnect).not.toHaveBeenCalled();

        } finally {
            unsubscribeMutations?.();
            stopConcurrentSessionCacheSync?.();
            consoleErrorSpy.mockRestore();
            localStorageHandle.restore();
        }
    });
});
