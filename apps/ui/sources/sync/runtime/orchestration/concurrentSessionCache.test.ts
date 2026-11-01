import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConcurrentTargets } from './concurrentSessionCache';
import { createSocketHarness } from '@/dev/testkit';
import { DEFAULT_MANAGED_CONNECTION_POLICY } from '@happier-dev/connection-supervisor';

const ioBoundary = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: ioBoundary }));

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

describe('resolveConcurrentTargets', () => {
    it.each([false, true])('keeps non-active server HTTP healthy through escalating socket failures and defers dials while HTTP is offline (already online=%s)', async (alreadyOnline) => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const reachability = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const { runtimeFetchWithServerReachability } = await import('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch');
        const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', 'concurrent-socket-http-admission');
        const active = profiles.upsertServerProfile({ serverUrl: 'https://active-socket.example.test' });
        const remote = profiles.upsertServerProfile({ serverUrl: 'https://remote-socket.example.test' });
        profiles.setActiveServerId(active.id, { scope: 'device' });
        storage.setState(storage.getInitialState(), true);
        storage.setState((state) => ({ settings: {
            ...state.settings,
            serverSelectionGroups: [{ id: 'socket-http', name: 'Socket HTTP', serverIds: [active.id, remote.id], presentation: 'grouped' }],
            serverSelectionActiveTargetKind: 'group', serverSelectionActiveTargetId: 'socket-http',
        } }));
        // Credential persistence and Socket.IO are external boundaries; all cache/readiness logic stays real.
        const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: 'token-remote' });
        const dialTimes: number[] = [];
        let socketHealthy = false;
        let httpHealthy = true;
        let failConnectedSocket = () => {};
        ioBoundary.mockImplementation(() => {
            let events = createSocketHarness<Record<string, unknown>>();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const socket = {
                connected: false,
                on: (event: string, listener: (payload: unknown) => void) => events.on(event, listener),
                off: (event: string, listener: (payload: unknown) => void) => events.off(event, listener),
                onAny() {}, offAny() {}, removeAllListeners() { events = createSocketHarness<Record<string, unknown>>(); },
                connect() {
                    dialTimes.push(Date.now());
                    timer = setTimeout(() => {
                        socket.connected = socketHealthy;
                        events.emit(socketHealthy ? 'connect' : 'connect_error', socketHealthy ? undefined : new Error('WebSocket blocked'));
                    }, 25);
                },
                disconnect() {
                    clearTimeout(timer);
                    const connected = socket.connected;
                    socket.connected = false;
                    if (connected) events.emit('disconnect', 'io client disconnect');
                },
            };
            failConnectedSocket = () => { socket.connected = false; events.emit('disconnect', 'transport close'); };
            // The scripted boundary implements only Socket.IO methods consumed by this transport.
            return socket as unknown as ReturnType<typeof import('socket.io-client')['io']>;
        });
        setRuntimeFetch(async () => new Response(JSON.stringify({ ok: true, sessions: [], machines: [] }), {
            status: httpHealthy ? 200 : 503, headers: httpHealthy ? {} : { 'Retry-After': '1' },
        }));
        reachability.setServerReachabilityNetworkAllowed(true);
        if (alreadyOnline) await reachability.startServerReachabilitySupervisor({ serverUrl: remote.serverUrl, token: 'token-remote' });
        vi.useFakeTimers();
        try {
            startConcurrentSessionCacheSync();
            await vi.advanceTimersByTimeAsync(25);
            expect(dialTimes).toHaveLength(1);
            expect(reachability.peekServerReachabilityState(remote.serverUrl)?.phase).toBe('online');
            while (dialTimes.length < 6) await vi.advanceTimersToNextTimerAsync();
            await vi.advanceTimersByTimeAsync(25);
            expect(dialTimes[5] - dialTimes[4]).toBeGreaterThan(dialTimes[4] - dialTimes[3]);
            expect(reachability.peekServerReachabilityState(remote.serverUrl)?.phase).toBe('online');
            for (const method of ['GET', 'POST']) {
                expect((await runtimeFetchWithServerReachability({ serverUrl: remote.serverUrl, token: 'token-remote',
                    url: `${remote.serverUrl}/ordinary-${method}`, init: { method },
                })).status).toBe(200);
            }
            httpHealthy = false;
            await reachability.invalidateServerReachabilitySupervisor({ serverUrl: remote.serverUrl, token: 'token-remote' });
            const offlineDials = dialTimes.length;
            const offlineObservationMs = DEFAULT_MANAGED_CONNECTION_POLICY.backoffMaxMs
                * (1 + DEFAULT_MANAGED_CONNECTION_POLICY.jitterRatio) + 25;
            await vi.advanceTimersByTimeAsync(offlineObservationMs);
            expect(reachability.peekServerReachabilityState(remote.serverUrl)?.phase).toBe('offline');
            expect(dialTimes).toHaveLength(offlineDials);
            httpHealthy = true;
            socketHealthy = true;
            await reachability.invalidateServerReachabilitySupervisor({ serverUrl: remote.serverUrl, token: 'token-remote' });
            await vi.advanceTimersByTimeAsync(25);
            expect(dialTimes).toHaveLength(offlineDials + 1);
            const failedAt = Date.now();
            failConnectedSocket();
            await vi.advanceTimersByTimeAsync(275);
            expect(dialTimes.at(-1)! - failedAt).toBe(250);
            stopConcurrentSessionCacheSync();
            const stoppedDials = dialTimes.length;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(dialTimes).toHaveLength(stoppedDials);
        } finally {
            stopConcurrentSessionCacheSync();
            await reachability.resetServerReachabilitySupervisors();
            resetRuntimeFetch(); credentials.mockRestore(); ioBoundary.mockReset();
            storage.setState(storage.getInitialState(), true);
            vi.useRealTimers(); vi.unstubAllEnvs();
        }
    });

    const profiles = [
        { id: 'server-a', serverUrl: 'https://a.example.test', name: 'Server A' },
        { id: 'server-b', serverUrl: 'https://b.example.test', name: 'Server B' },
        { id: 'server-c', serverUrl: 'https://c.example.test', name: 'Server C' },
    ] as const;

    it('returns selected non-active server targets when active selection is a group', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'server-a',
            profiles,
            settings: {
                serverSelectionGroups: [
                    {
                        id: 'group-main',
                        name: 'Main',
                        serverIds: ['server-a', 'server-c'],
                        presentation: 'grouped',
                    },
                ],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'group-main',
            },
        });
        expect(result).toEqual([
            {
                id: 'server-c',
                serverUrl: 'https://c.example.test',
                serverName: 'Server C',
            },
        ]);
    });

    it('returns empty targets when active selection is a concrete server', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'server-a',
            profiles,
            settings: {
                serverSelectionGroups: [],
                serverSelectionActiveTargetKind: 'server',
                serverSelectionActiveTargetId: 'server-a',
            },
        });
        expect(result).toEqual([]);
    });

    it('honors explicit active server target and ignores concurrent selection sets', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'server-a',
            profiles,
            settings: {
                serverSelectionGroups: [],
                serverSelectionActiveTargetKind: 'server',
                serverSelectionActiveTargetId: 'server-b',
            } as any,
        });
        expect(result).toEqual([]);
    });

    it('honors explicit group target when resolving concurrent targets', () => {
        const result = resolveConcurrentTargets({
            activeServerId: 'server-b',
            profiles,
            settings: {
                serverSelectionGroups: [
                    {
                        id: 'group-dev',
                        name: 'Dev',
                        serverIds: ['server-b', 'server-c'],
                        presentation: 'grouped',
                    },
                ],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'group-dev',
            } as any,
        });
        expect(result).toEqual([
            {
                id: 'server-c',
                serverUrl: 'https://c.example.test',
                serverName: 'Server C',
            },
        ]);
    });

    it('publishes the selected promoted Home through the real concurrent reconciliation owner', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `concurrent-promoted-${Math.random()}`);
        const active = profiles.upsertServerProfile({ serverUrl: 'https://concurrent-active.example.test' });
        const remote = profiles.upsertServerProfile({ serverUrl: 'https://concurrent-promoted.example.test' });
        profiles.setActiveServerId(active.id, { scope: 'device' });
        profiles.setServerProfileIdentityForUrl(remote.serverUrl, 'srv_concurrent_promoted');
        storage.setState(storage.getInitialState(), true);
        storage.setState((state) => ({
            settings: {
                ...state.settings,
                serverSelectionGroups: [{
                    id: 'promoted', name: 'Promoted', serverIds: [active.id, 'srv_concurrent_promoted'],
                    presentation: 'grouped',
                }],
                serverSelectionActiveTargetKind: 'group', serverSelectionActiveTargetId: 'promoted',
            },
        }));
        // Native credential storage is outside this process; an unauthenticated Home publishes null.
        const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(null);
        vi.useFakeTimers();
        try {
            startConcurrentSessionCacheSync();
            await vi.advanceTimersByTimeAsync(0);
            expect(storage.getState().sessionListViewDataByServerId).toEqual({ srv_concurrent_promoted: null });
            expect(storage.getState().machineListStatusByServerId.srv_concurrent_promoted).toBe('signedOut');
        } finally {
            stopConcurrentSessionCacheSync();
            credentials.mockRestore();
            vi.useRealTimers();
            vi.unstubAllEnvs();
        }
    });

    it('starts periodic refresh through the runtime-active gated interval', async () => {
        vi.resetModules();
        const stopInterval = vi.fn();
        const startRuntimeActiveGatedInterval = vi.fn(() => stopInterval);
        vi.doMock('@/utils/runtime/isRuntimeActive', () => ({
            isRuntimeActive: () => true,
            startRuntimeActiveGatedInterval,
        }));

        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        startConcurrentSessionCacheSync();

        expect(startRuntimeActiveGatedInterval).toHaveBeenCalledWith(expect.any(Function), expect.any(Number));

        stopConcurrentSessionCacheSync();
        expect(stopInterval).toHaveBeenCalledTimes(1);
    });
});
