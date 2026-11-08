import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Encryption } from '@/sync/encryption/encryption';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';

vi.mock('socket.io-client', async () => {
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    return { io: () => createSocketIoBoundaryStub().socket };
});

function createSocketStub() { return createSocketIoBoundaryStub().socket; }

// Prepare the source graph before the per-case mock/connection lifecycle.
// Each case still receives its fresh module graph and the original time budget.
await import('./apiSocket');
vi.resetModules();

afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unmock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    vi.resetModules();
    vi.clearAllMocks();
    try {
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
    } catch {
        // ignore
    }
});

describe('apiSocket reachability supervision', () => {
    it('reconnects after reachability returns online even when the recovery socket dial fails', async () => {
        const boundary = createSocketIoBoundaryStub({ autoConnect: false });
        vi.doMock('socket.io-client', () => ({ io: () => boundary.socket }));
        const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const pool = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        setRuntimeFetch(async () => new Response(null, { status: 200 }));
        await upsertAndActivateServer({ serverUrl: 'https://recovery.example.test' });
        const { apiSocket } = await import('./apiSocket');
        vi.useFakeTimers();
        try {
            apiSocket.initialize({ endpoint: 'https://recovery.example.test', token: 'recovery-token' }, null);
            await vi.advanceTimersByTimeAsync(0);
            boundary.trigger('connect');
            await vi.advanceTimersByTimeAsync(0);
            expect(boundary.socket.connected).toBe(true);

            pool.reportServerRestarting('https://recovery.example.test', 1_000, 'recovery-token');
            await vi.advanceTimersByTimeAsync(0);
            expect(boundary.socket.connected).toBe(false);
            // A refused recovery dial retains demand at the managed socket
            // backoff owner while HTTP readiness can stay online.
            boundary.socket.connect.mockImplementationOnce(() => {
                boundary.socket.active = false;
                boundary.trigger('connect_error', new Error('Recovery dial refused'));
            });
            await vi.advanceTimersByTimeAsync(1_000);
            expect(pool.peekServerReachabilityState('https://recovery.example.test', 'recovery-token')?.phase).toBe('online');
            expect(boundary.socket.active).toBe(false);
            await vi.advanceTimersByTimeAsync(250);
            expect(boundary.socket.active).toBe(true);
            boundary.trigger('connect');
            expect(boundary.socket.connected).toBe(true);
        } finally {
            apiSocket.disconnect();
            resetRuntimeFetch();
        }
    });

    it.each(['loopback', 'semantic'] as const)('does not import an ambient %s Home carrier into an exact HTTPS target', async kind => {
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const pool = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const previousServerId = runtime.getActiveServerSnapshot().serverId;
        await runtime.upsertAndActivateServer({ serverUrl: 'https://b.example.test' });
        const target = runtime.captureActiveServerRuntimeTarget();
        const lease = { target, leaseId: 'ambient-b-test-lease' };
        const carrier = { endpointId: 'ambient-b-carrier', readObservedPath: () => 'relay' as const,
            request: vi.fn(async () => Response.json({})), createWebSocket: vi.fn() };
        expect(runtime.publishActiveServerRuntimeOrigin({ ...lease, carrier: 'iroh',
            ...(kind === 'loopback' ? { runtimeOrigin: 'http://127.0.0.1:49999' } : { homeCarrier: carrier }) })).toBe(true);
        const start = vi.spyOn(pool, 'startServerReachabilitySupervisor');
        const requestOrigins: string[] = [];
        setRuntimeFetch(async input => {
            requestOrigins.push(new URL(String(input)).origin);
            return Response.json({});
        });
        let socket: typeof import('./apiSocket')['apiSocket'] | undefined;
        try {
            ({ apiSocket: socket } = await import('./apiSocket'));
            const token = 'token-a';
            socket.initialize({ endpoint: 'https://a.example.test', token,
                serverId: 'server-a', generation: 3, homeCarrier: null }, null);
            expect(start.mock.calls.map(([params]) => params)).toEqual([{
                serverUrl: 'https://a.example.test', runtimeOrigin: 'https://a.example.test', token, homeCarrier: null,
            }]);
            await vi.waitFor(() => expect(requestOrigins).toContain(new URL('https://a.example.test').origin));
            expect(requestOrigins.every(value => value === new URL('https://a.example.test').origin)).toBe(true);
            expect(carrier.request).not.toHaveBeenCalled();
        } finally {
            socket?.disconnect();
            start.mockRestore();
            resetRuntimeFetch();
            runtime.releaseActiveServerRuntimeOrigin(lease);
            await runtime.setActiveServer({ serverId: previousServerId });
        }
    });

    it('re-subscribes to reachability when initialized with a new endpoint', async () => {
        const unsubscribeSpy = vi.fn();
        const subscribeSpy = vi.fn((_serverUrl: string, listener: (state: any) => void) => {
            listener({
                phase: 'offline',
                reason: 'initial_connect',
                attempt: 0,
                nextRetryAt: null,
                lastConnectedAt: null,
                lastDisconnectedAt: Date.now(),
                lastErrorMessage: null,
            });
            return unsubscribeSpy;
        });

        vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
            return {
                ...actual,
                subscribeServerReachabilityState: subscribeSpy,
                startServerReachabilitySupervisor: vi.fn(async () => {}),
            };
        });

        vi.doMock('socket.io-client', () => ({ io: vi.fn(() => createSocketStub()) }));

        const { apiSocket } = await import('./apiSocket');
        const encryption = { getSessionEncryption: () => null } as unknown as Encryption;

        apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);
        expect(subscribeSpy).toHaveBeenCalledTimes(1);

        apiSocket.initialize({ endpoint: 'https://api2.example.test', token: 'token-a' }, encryption);

        expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
        expect(subscribeSpy).toHaveBeenCalledTimes(2);
    });

    it('restarts reachability supervision when the token changes before the socket is created', async () => {
        const startSpy = vi.fn(async () => {});

        vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
            return {
                ...actual,
                subscribeServerReachabilityState: (_serverUrl: string, listener: (state: any) => void) => {
                    listener({
                        phase: 'offline',
                        reason: 'initial_connect',
                        attempt: 0,
                        nextRetryAt: null,
                        lastConnectedAt: null,
                        lastDisconnectedAt: Date.now(),
                        lastErrorMessage: null,
                    });
                    return () => {};
                },
                startServerReachabilitySupervisor: startSpy,
            };
        });

        vi.doMock('socket.io-client', () => ({ io: vi.fn(() => createSocketStub()) }));

        const { apiSocket } = await import('./apiSocket');
        const encryption = { getSessionEncryption: () => null } as unknown as Encryption;
        apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);
        expect(startSpy).toHaveBeenCalledTimes(1);

        apiSocket.updateToken('token-b');
        expect(startSpy).toHaveBeenCalledTimes(2);
    });

    it('fires onReconnected after reachability outage cycles', async () => {
        const reachability = {
            listener: (_state: any): void => {},
        };
        vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
            return {
                ...actual,
                subscribeServerReachabilityState: (_serverUrl: string, listener: (state: any) => void) => {
                    reachability.listener = listener;
                    return () => {};
                },
                startServerReachabilitySupervisor: vi.fn(async () => {}),
            };
        });

        const fakeSocket = createSocketStub();
        vi.doMock('socket.io-client', () => ({ io: () => fakeSocket }));

        const { apiSocket } = await import('./apiSocket');
        const encryption = { getSessionEncryption: () => null } as unknown as Encryption;
        apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);

        const reconnectedSpy = vi.fn();
        apiSocket.onReconnected(reconnectedSpy);

        reachability.listener({
            phase: 'online',
            reason: 'initial_connect',
            attempt: 0,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        });

        await vi.waitFor(() => expect(fakeSocket.connected).toBe(true));

        reachability.listener({
            phase: 'offline',
            reason: 'disconnect',
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: Date.now(),
            lastErrorMessage: null,
        });

        reachability.listener({
            phase: 'online',
            reason: 'reconnect',
            attempt: 2,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        });

        await vi.waitFor(() => expect(reconnectedSpy).toHaveBeenCalledTimes(1));
    });

    it('delays socket.connect() until reachability is online', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);

        const fakeSocket = createSocketStub();
        const ioSpy = vi.fn((..._args: any[]) => fakeSocket);
        vi.doMock('socket.io-client', () => ({
            io: (uri?: unknown, opts?: unknown) => ioSpy(uri, opts),
        }));

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String(input);
            // Reachability must never come online here, so every readiness route has to fail: an authenticated
            // client probes /v1/auth/ping, a tokenless one probes /health.
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                throw new TypeError('Network request failed');
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
            get runtimeFetchManualResponse() { return this.runtimeFetch; },
        }));

        const { apiSocket } = await import('./apiSocket');
        const encryption = { getSessionEncryption: () => null } as unknown as Encryption;
        apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);

        expect(fakeSocket.connect).not.toHaveBeenCalled();
    });

    it('does not report server unreachable during intentional disconnect teardown', async () => {
        const fakeSocket = createSocketStub();

        const reportServerUnreachableSpy = vi.fn<(...args: any[]) => void>();
        const startServerReachabilitySupervisorSpy = vi.fn<(...args: any[]) => Promise<void>>(async () => {});

        vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
            return {
                ...actual,
                subscribeServerReachabilityState: (_serverUrl: string, listener: (state: any) => void) => {
                    listener({
                        phase: 'online',
                        reason: 'initial_connect',
                        attempt: 0,
                        nextRetryAt: null,
                        lastConnectedAt: Date.now(),
                        lastDisconnectedAt: null,
                        lastErrorMessage: null,
                    });
                    return () => {};
                },
                startServerReachabilitySupervisor: startServerReachabilitySupervisorSpy,
                reportServerUnreachable: reportServerUnreachableSpy,
            };
        });

        vi.doMock('socket.io-client', () => ({ io: () => fakeSocket }));

        const { apiSocket } = await import('./apiSocket');
        const encryption = { getSessionEncryption: () => null } as unknown as Encryption;
        apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);

        apiSocket.disconnect();

        expect(startServerReachabilitySupervisorSpy).toHaveBeenCalled();
        expect(reportServerUnreachableSpy).not.toHaveBeenCalled();
    });

    it('keeps apiSocket.request pending until caller cancellation while Home is offline', async () => {
        vi.doMock('@/sync/domains/server/serverRuntime', async (importOriginal) => ({
            ...await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>(),
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'https://api.example.test',
                kind: 'custom',
                generation: 1,
            }),
        }));

        vi.doMock('@/auth/storage/tokenStorage', async (importOriginal) => ({
            ...await importOriginal<typeof import('@/auth/storage/tokenStorage')>(),
            TokenStorage: {
                getCredentialsForServerUrl: vi.fn(async () => ({ token: 'token-a', secret: 'secret-a' })),
                getCredentials: vi.fn(async () => ({ token: 'token-a', secret: 'secret-a' })),
                invalidateCredentialsTokenForServerUrl: vi.fn(async () => false),
                invalidateCredentialsToken: vi.fn(async () => false),
            },
        }));

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String(input);
            // "The network is down" must fail every readiness route: an authenticated client probes
            // /v1/auth/ping, a tokenless one probes /health.
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                throw new TypeError('Network request failed');
            }
            if (url.endsWith('/v1/account/profile')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
            get runtimeFetchManualResponse() { return this.runtimeFetch; },
        }));

        const { apiSocket } = await import('./apiSocket');
        vi.useFakeTimers();
        const encryption = { getSessionEncryption: () => null } as unknown as Encryption;
        apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);

        const cancellation = new AbortController();
        let settled = false;
        const request = apiSocket.request('/v1/account/profile', { method: 'GET', signal: cancellation.signal })
            .finally(() => { settled = true; });
        const assertion = expect(request).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(settled).toBe(false);
        cancellation.abort();
        await assertion;

        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).includes('/v1/account/profile'))).toBe(false);
    });

    it('stops reachability supervision when disconnecting', async () => {
        const unsubscribeSpy = vi.fn();
        const stopSpy = vi.fn(async (_serverUrl: string) => {});

        vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
            return {
                ...actual,
                subscribeServerReachabilityState: (_serverUrl: string, listener: (state: any) => void) => {
                    listener({
                        phase: 'offline',
                        reason: 'initial_connect',
                        attempt: 0,
                        nextRetryAt: null,
                        lastConnectedAt: null,
                        lastDisconnectedAt: Date.now(),
                        lastErrorMessage: null,
                    });
                    return unsubscribeSpy;
                },
                startServerReachabilitySupervisor: vi.fn(async () => {}),
                stopServerReachabilitySupervisor: stopSpy,
            };
        });

        vi.doMock('socket.io-client', () => ({ io: vi.fn(() => createSocketStub()) }));

        const { apiSocket } = await import('./apiSocket');
        const encryption = { getSessionEncryption: () => null } as unknown as Encryption;

        apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);
        apiSocket.disconnect();

        expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(stopSpy.mock.calls[0]?.[0]).toBe('https://api.example.test');
    });

    it('stops claiming a live endpoint when supervision is torn down intentionally', async () => {
        // disconnect() unsubscribes from the reachability entry BEFORE stopping it, so the supervisor's own
        // teardown state can never reach our listeners. Without publishing it ourselves the last claim stays
        // `online` for the whole background window, and consumers read "endpoint online, socket down" on resume
        // and surface it as a server outage.
        const stopSpy = vi.fn(async (_serverUrl: string) => {});

        vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
            return {
                ...actual,
                subscribeServerReachabilityState: (_serverUrl: string, listener: (state: any) => void) => {
                    listener({
                        phase: 'online',
                        reason: null,
                        attempt: 0,
                        nextRetryAt: null,
                        lastConnectedAt: Date.now(),
                        lastDisconnectedAt: null,
                        lastErrorMessage: null,
                    });
                    return vi.fn();
                },
                startServerReachabilitySupervisor: vi.fn(async () => {}),
                stopServerReachabilitySupervisor: stopSpy,
            };
        });

        vi.doMock('socket.io-client', () => ({ io: vi.fn(() => createSocketStub()) }));

        const { apiSocket } = await import('./apiSocket');
        const encryption = { getSessionEncryption: () => null } as unknown as Encryption;

        const observedPhases: string[] = [];
        apiSocket.onConnectionStateChange((state) => {
            observedPhases.push(state.phase);
        });

        apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);
        expect(observedPhases.at(-1)).toBe('online');

        apiSocket.disconnect();

        expect(observedPhases.at(-1)).toBe('shutting_down');
    });

    describe('focused Iroh runtime-origin supervision', () => {
        let currentSnapshot: Record<string, unknown> = {};
        const irohProfile = {
            id: 'srv_home',
            name: 'Home',
            serverUrl: 'https://api.example.test',
            canonicalServerUrl: 'https://api.example.test',
            serverIdentityId: 'srv_home',
            homeConnectionDescriptor: {
                v: 1,
                homeServerIdentityId: 'srv_home',
                canonicalServerUrl: 'https://api.example.test',
                revision: 1,
                endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] }],
            },
            publicServerUrl: null,
        };

        function mockFocusedHomeRuntimeContext(params: Readonly<{ profile: Record<string, unknown> | null }> = { profile: irohProfile }): void {
            vi.doMock('@/sync/domains/server/serverRuntime', async (importOriginal) => ({
                ...await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>(),
                getActiveServerSnapshot: () => currentSnapshot,
            }));
            vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
                const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
                return {
                    ...actual,
                    getServerProfileById: (id: unknown) => (
                        params.profile && String(id) === params.profile.id ? params.profile : null
                    ),
                };
            });
        }

        it('keys focused reachability by the canonical Home URL with the verified Iroh origin as metadata', async () => {
            const subscribeUrls: string[] = [];
            const startParams: Array<Record<string, unknown>> = [];
            vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
                const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
                return {
                    ...actual,
                    subscribeServerReachabilityState: (serverUrl: string, _listener: (state: any) => void) => {
                        subscribeUrls.push(serverUrl);
                        return () => {};
                    },
                    startServerReachabilitySupervisor: async (params: Record<string, unknown>) => {
                        startParams.push(params);
                    },
                };
            });
            vi.doMock('socket.io-client', () => ({ io: vi.fn(() => createSocketStub()) }));
            mockFocusedHomeRuntimeContext();

            currentSnapshot = {
                serverId: 'srv_home',
                serverUrl: 'https://api.example.test',
                carrier: 'iroh',
                runtimeOrigin: 'http://127.0.0.1:43111',
                generation: 1,
            };

            const { apiSocket } = await import('./apiSocket');
            const encryption = { getSessionEncryption: () => null } as unknown as Encryption;
            apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);

            // One canonical pool entry for the Home; the loopback origin is metadata, never a key.
            expect(subscribeUrls).toEqual(['https://api.example.test']);
            expect(startParams[0]).toMatchObject({
                serverUrl: 'https://api.example.test',
                token: 'token-a',
                runtimeOrigin: 'http://127.0.0.1:43111',
            });
        });

        it('waits for the verified runtime origin when public HTTPS contains embedded credentials', async () => {
            const startParams: Array<Record<string, unknown>> = [];
            const originListenerRef: { current: ((snapshot: Record<string, unknown>) => void) | null } = { current: null };
            const invalidPublicHttpsProfile = {
                ...irohProfile,
                publicServerUrl: 'https://admin:secret@public.example.test/api?source=descriptor#home',
            };
            vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
                const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
                return {
                    ...actual,
                    subscribeServerReachabilityState: (_serverUrl: string, _listener: (state: any) => void) => () => {},
                    startServerReachabilitySupervisor: async (params: Record<string, unknown>) => {
                        startParams.push(params);
                    },
                };
            });
            vi.doMock('@/sync/domains/server/serverRuntime', async (importOriginal) => ({
                ...await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>(),
                getActiveServerSnapshot: () => currentSnapshot,
            }));
            vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
                const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
                return {
                    ...actual,
                    getServerProfileById: (id: unknown) => (String(id) === 'srv_home' ? invalidPublicHttpsProfile : null),
                    subscribeActiveServerRuntimeOrigin: (listener: (snapshot: Record<string, unknown>) => void) => {
                        originListenerRef.current = listener;
                        return () => {};
                    },
                };
            });
            vi.doMock('socket.io-client', () => ({ io: vi.fn(() => createSocketStub()) }));

            // Foreground recovery starts from the suspended world: no published origin.
            currentSnapshot = {
                serverId: 'srv_home',
                serverUrl: 'https://api.example.test',
                generation: 1,
            };

            const { apiSocket } = await import('./apiSocket');
            const encryption = { getSessionEncryption: () => null } as unknown as Encryption;
            apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);
            // The canonical URL is the auth audience, not fallback proof. With
            // no descriptor-proven HTTPS ingress, foreground waits for the
            // verified Iroh origin instead of probing the canonical URL.
            expect(startParams).toHaveLength(0);

            // The native lease re-verifies and republishes; supervision must re-arm with
            // the fresh verified origin so the probe and socket rebind stop targeting the
            // suspended transport.
            currentSnapshot = {
                ...currentSnapshot,
                carrier: 'iroh',
                runtimeOrigin: 'http://127.0.0.1:43222',
            };
            originListenerRef.current?.(currentSnapshot);

            expect(startParams[0]).toMatchObject({
                serverUrl: 'https://api.example.test',
                token: 'token-a',
                runtimeOrigin: 'http://127.0.0.1:43222',
            });
        });

        it('does not probe canonical loopback for a loopback-only Iroh Home until the origin republishes', async () => {
            const loopbackProfile = {
                ...irohProfile,
                serverUrl: 'http://127.0.0.1:3010',
                canonicalServerUrl: 'http://127.0.0.1:3010',
                homeConnectionDescriptor: { ...irohProfile.homeConnectionDescriptor, canonicalServerUrl: 'http://127.0.0.1:3010' },
                publicServerUrl: null,
            };
            const startParams: Array<Record<string, unknown>> = [];
            const originListenerRef: { current: ((snapshot: Record<string, unknown>) => void) | null } = { current: null };
            vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
                const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
                return {
                    ...actual,
                    subscribeServerReachabilityState: (_serverUrl: string, _listener: (state: any) => void) => () => {},
                    startServerReachabilitySupervisor: async (params: Record<string, unknown>) => {
                        startParams.push(params);
                    },
                };
            });
            vi.doMock('@/sync/domains/server/serverRuntime', async (importOriginal) => ({
                ...await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>(),
                getActiveServerSnapshot: () => currentSnapshot,
            }));
            vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
                const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
                return {
                    ...actual,
                    getServerProfileById: (id: unknown) => (String(id) === 'srv_home' ? loopbackProfile : null),
                    subscribeActiveServerRuntimeOrigin: (listener: (snapshot: Record<string, unknown>) => void) => {
                        originListenerRef.current = listener;
                        return () => {};
                    },
                };
            });
            vi.doMock('socket.io-client', () => ({ io: vi.fn(() => createSocketStub()) }));

            // Suspended: the canonical audience is this device's loopback URL, which is not
            // a network route to the Home. Supervision must wait for the verified origin.
            currentSnapshot = {
                serverId: 'srv_home',
                serverUrl: 'http://127.0.0.1:3010',
                generation: 1,
            };

            const { apiSocket } = await import('./apiSocket');
            const encryption = { getSessionEncryption: () => null } as unknown as Encryption;
            apiSocket.initialize({ endpoint: 'http://127.0.0.1:3010', token: 'token-a' }, encryption);
            expect(startParams).toEqual([]);

            // Verified republish arms supervision with the fresh origin as metadata.
            currentSnapshot = {
                ...currentSnapshot,
                carrier: 'iroh',
                runtimeOrigin: 'http://127.0.0.1:43333',
            };
            originListenerRef.current?.(currentSnapshot);
            expect(startParams).toHaveLength(1);
            expect(startParams[0]).toMatchObject({
                serverUrl: 'http://127.0.0.1:3010',
                token: 'token-a',
                runtimeOrigin: 'http://127.0.0.1:43333',
            });
        });
    });
});
