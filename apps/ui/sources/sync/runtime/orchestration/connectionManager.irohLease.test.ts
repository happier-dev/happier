import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTokenStorageModuleMock } from '@/dev/testkit';
import { IrohError } from '@happier-dev/iroh-native';

function createIrohRuntimeMock() {
    return {
        getIrohHomeTunnelRuntime: () => irohRuntimeMock,
        ensureHomeTunnel: vi.fn(async () => ({
            leaseId: 'iroh-home:test',
            key: 'test',
            remoteHostId: 'srv_home_a',
            localUrl: 'http://127.0.0.1:46101',
            channelMode: 'loopback-port',
            purpose: 'home',
            status: 'ready',
            startedAt: '2026-08-30T00:00:00.000Z',
            homeServerIdentityId: 'srv_home_a',
            endpointId: 'endpoint-a',
            carrier: 'iroh',
            observedPath: 'direct',
        })),
        releaseHomeTunnel: vi.fn(async () => undefined),
        releaseActiveHomeTunnels: vi.fn(async () => undefined),
        releaseLeasesForStaleTargets: vi.fn(async () => undefined),
        markSuspended: vi.fn(),
        markForeground: vi.fn(async () => undefined),
        listTunnels: vi.fn(() => ({ leases: [], platformLimitations: [] })),
        subscribeRecoveryRequired: vi.fn((listener: typeof recoveryRequiredListener) => {
            recoveryRequiredListener = listener;
            return () => {
                if (recoveryRequiredListener === listener) recoveryRequiredListener = null;
            };
        }),
    };
}

const irohRuntimeMock = createIrohRuntimeMock();

const startLifecycleSpy = vi.fn();
const publishActiveServerRuntimeOriginSpy = vi.fn(() => true);
let recoveryRequiredListener: ((event: Readonly<{
    leaseId: string;
    homeServerIdentityId: string;
    reason: 'terminal' | 'foreground_probe_failed';
    activePublication: boolean;
}>) => void) | null = null;

function mockActiveSnapshot(snapshot: Record<string, unknown>): void {
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => snapshot,
        captureActiveServerRuntimeTarget: () => ({
            serverId: String(snapshot.serverId ?? ''),
            generation: Number(snapshot.generation ?? 0),
        }),
        getActiveServerHomeCarrier: () => undefined,
        publishActiveServerRuntimeOrigin: publishActiveServerRuntimeOriginSpy,
        releaseActiveServerRuntimeOrigin: vi.fn(),
    }));
}

function buildExactIrohProfileFixture(profile: Record<string, unknown>): Record<string, unknown> {
    const { irohEndpoint: endpoint, connectionDescriptorRevision: revision, ...persistedProfile } = profile;
    if (!endpoint) return persistedProfile;
    const canonicalServerUrl = String(profile.canonicalServerUrl ?? profile.serverUrl ?? '');
    const publicServerUrl = typeof profile.publicServerUrl === 'string' && profile.publicServerUrl.trim()
        ? (() => {
            const url = new URL(profile.publicServerUrl.trim());
            url.search = '';
            url.hash = '';
            return url.toString().replace(/\/+$/u, '');
        })()
        : null;
    return {
        ...persistedProfile,
        canonicalServerUrl,
        homeConnectionDescriptor: {
            v: 1,
            homeServerIdentityId: String(profile.serverIdentityId ?? ''),
            canonicalServerUrl,
            revision: Number(revision ?? 1),
            endpoints: [
                ...(publicServerUrl ? [{ kind: 'https', url: publicServerUrl }] : []),
                { kind: 'iroh', ...(endpoint as Record<string, unknown>) },
            ],
        },
    };
}

function mockProfile(profile: Record<string, unknown> | null): void {
    const normalizedProfile = profile ? buildExactIrohProfileFixture(profile) : null;
    vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
        ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
        getServerProfileById: (_id: string) => normalizedProfile,
    }));
}

function mockTokenStorage(credentials: { token: string; secret: string } | null): void {
    vi.doMock('@/auth/storage/tokenStorage', async (importOriginal) => await createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentials: vi.fn(async () => credentials),
            getCredentialsForServerUrl: vi.fn(async () => credentials),
        },
    }));
}

function mockSyncInfra(): {
    syncSwitchServer: ReturnType<typeof vi.fn>;
    retryNow: ReturnType<typeof vi.fn>;
    abortServerFetches: ReturnType<typeof vi.fn>;
} {
    const syncSwitchServer = vi.fn(async (
        _credentials: { token: string; secret: string } | null,
        _target?: Readonly<{ serverId: string; serverUrl: string; generation: number }>,
    ) => {});
    const retryNow = vi.fn();
    const abortServerFetches = vi.fn();
    vi.doMock('@/sync/sync', () => ({ syncSwitchServer, sync: { retryNow } }));
    vi.doMock('@/sync/http/client', async (importOriginal) => ({
        ...(await importOriginal<typeof import('@/sync/http/client')>()),
        abortServerFetches,
    }));
    return { syncSwitchServer, retryNow, abortServerFetches };
}

describe('switchConnectionToActiveServer Iroh lease acquisition', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        irohRuntimeMock.ensureHomeTunnel.mockClear();
        irohRuntimeMock.releaseLeasesForStaleTargets.mockClear();
        irohRuntimeMock.releaseActiveHomeTunnels.mockClear();
        startLifecycleSpy.mockClear();
        publishActiveServerRuntimeOriginSpy.mockClear();
        recoveryRequiredListener = null;
    });

    it('acquires and verifies the Iroh lease for an Iroh Home before syncSwitchServer', async () => {
        mockActiveSnapshot({
            serverId: 'srv_home_a',
            serverUrl: 'https://iroh-home.example.test',
            kind: 'custom',
            generation: 42,
        });
        mockProfile({
            id: 'profile-a',
            serverIdentityId: 'srv_home_a',
            serverUrl: 'https://iroh-home.example.test',
            irohEndpoint: { endpointId: 'endpoint-a', relayUrls: ['https://relay.example.test'] },
            connectionDescriptorRevision: 7,
        });
        mockTokenStorage({ token: 'scoped-token', secret: 'scoped-secret' });
        const { syncSwitchServer } = mockSyncInfra();
        vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
            getIrohHomeTunnelRuntime: () => irohRuntimeMock,
        }));
        vi.doMock('@/sync/runtime/nativeLoopbackTunnels/runtime', () => ({
            startNativeLoopbackTunnelRuntimeAppStateLifecycle: startLifecycleSpy,
        }));

        const { switchConnectionToActiveServer } = await import('./connectionManager');
        await switchConnectionToActiveServer();

        expect(irohRuntimeMock.ensureHomeTunnel).toHaveBeenCalledTimes(1);
        expect(irohRuntimeMock.ensureHomeTunnel).toHaveBeenCalledWith({
            homeServerIdentityId: 'srv_home_a',
            endpoint: { kind: 'iroh', endpointId: 'endpoint-a', relayUrls: ['https://relay.example.test'] },
            canonicalServerUrl: 'https://iroh-home.example.test',
            verification: { kind: 'authenticated', token: 'scoped-token' },
        });
        expect(startLifecycleSpy).toHaveBeenCalled();
        // The verified lease exists before the sync switch so HTTP and Socket.IO
        // resolve the published runtime origin for this same active generation.
        expect(irohRuntimeMock.ensureHomeTunnel.mock.invocationCallOrder[0])
            .toBeLessThan(syncSwitchServer.mock.invocationCallOrder[0]);
        expect(irohRuntimeMock.releaseLeasesForStaleTargets).not.toHaveBeenCalled();
        expect(syncSwitchServer).toHaveBeenCalledWith(
            { token: 'scoped-token', secret: 'scoped-secret' },
            expect.objectContaining({
                serverId: 'srv_home_a',
                serverUrl: 'https://iroh-home.example.test',
                generation: 42,
            }),
        );
    });

    it.each(['terminal', 'foreground_probe_failed'] as const)(
        'reacquires a dead focused lease through the one active-connection retry owner for %s recovery',
        async (reason) => {
            mockActiveSnapshot({
                serverId: 'srv_home_a',
                serverUrl: 'https://iroh-home.example.test',
                kind: 'custom',
                generation: 42,
            });
            mockProfile({
                id: 'profile-a',
                serverIdentityId: 'srv_home_a',
                serverUrl: 'https://iroh-home.example.test',
                irohEndpoint: { endpointId: 'endpoint-a' },
                connectionDescriptorRevision: 7,
            });
            mockTokenStorage({ token: 'scoped-token', secret: 'scoped-secret' });
            const { syncSwitchServer, retryNow } = mockSyncInfra();
            vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
                getIrohHomeTunnelRuntime: () => irohRuntimeMock,
            }));
            vi.doMock('@/sync/runtime/nativeLoopbackTunnels/runtime', () => ({
                startNativeLoopbackTunnelRuntimeAppStateLifecycle: startLifecycleSpy,
            }));

            const { switchConnectionToActiveServer } = await import('./connectionManager');
            await switchConnectionToActiveServer();
            irohRuntimeMock.ensureHomeTunnel.mockClear();
            syncSwitchServer.mockClear();

            recoveryRequiredListener?.({
                leaseId: 'iroh-home:test',
                homeServerIdentityId: 'srv_home_a',
                reason,
                activePublication: true,
            });

            await vi.waitFor(() => expect(irohRuntimeMock.ensureHomeTunnel).toHaveBeenCalledTimes(1));
            expect(retryNow).toHaveBeenCalledTimes(1);
            expect(syncSwitchServer).not.toHaveBeenCalled();
        },
    );

    it('acquires and verifies the Iroh lease before cold restore initializes Sync', async () => {
        mockActiveSnapshot({
            serverId: 'srv_home_a',
            serverUrl: 'http://127.0.0.1:3010',
            generation: 42,
        });
        mockProfile({
            id: 'profile-a',
            serverIdentityId: 'srv_home_a',
            serverUrl: 'http://127.0.0.1:3010',
            irohEndpoint: { endpointId: 'endpoint-a' },
            connectionDescriptorRevision: 7,
        });
        const credentials = { token: 'scoped-token', secret: 'scoped-secret' };
        mockTokenStorage(credentials);
        const { syncSwitchServer } = mockSyncInfra();
        const syncRestore = vi.fn(async () => undefined);
        const syncHydrateLocalState = vi.fn();
        vi.doMock('@/sync/sync', () => ({ syncSwitchServer, syncRestore, syncHydrateLocalState }));
        vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
            getIrohHomeTunnelRuntime: () => irohRuntimeMock,
        }));
        vi.doMock('@/sync/runtime/nativeLoopbackTunnels/runtime', () => ({
            startNativeLoopbackTunnelRuntimeAppStateLifecycle: startLifecycleSpy,
        }));

        const { restoreConnectionToActiveServer, isColdActiveServerRestorePending,
            subscribeColdActiveServerRestore } = await import('./connectionManager');
        const restoreStates: boolean[] = [];
        const unsubscribe = subscribeColdActiveServerRestore(() => {
            restoreStates.push(isColdActiveServerRestorePending());
        });
        expect(isColdActiveServerRestorePending()).toBe(false);
        const restore = restoreConnectionToActiveServer(credentials);
        expect(isColdActiveServerRestorePending()).toBe(true);
        await restore;
        expect(isColdActiveServerRestorePending()).toBe(false);
        expect(restoreStates).toEqual([true, false]);
        unsubscribe();

        expect(irohRuntimeMock.ensureHomeTunnel.mock.invocationCallOrder[0])
            .toBeLessThan(syncRestore.mock.invocationCallOrder[0]);
        // The warm cache is local: it reaches the store before the carrier is even asked.
        expect(syncHydrateLocalState.mock.invocationCallOrder[0])
            .toBeLessThan(irohRuntimeMock.ensureHomeTunnel.mock.invocationCallOrder[0]);
        expect(syncRestore).toHaveBeenCalledWith(
            credentials,
            expect.objectContaining({
                serverId: 'srv_home_a',
                serverUrl: 'http://127.0.0.1:3010',
                generation: 42,
            }),
        );
        expect(syncSwitchServer).not.toHaveBeenCalled();
    });

    it('serializes a switch requested while the cold restore is still acquiring its carrier', async () => {
        // Boot now paints after restore's local phase, so the UI (Retry, pull-to-refresh,
        // foreground reprobe) can reach the switch owner while the carrier is pending.
        mockActiveSnapshot({
            serverId: 'srv_home_a',
            serverUrl: 'http://127.0.0.1:3010',
            generation: 44,
        });
        mockProfile({
            id: 'profile-a',
            serverIdentityId: 'srv_home_a',
            serverUrl: 'http://127.0.0.1:3010',
            irohEndpoint: { endpointId: 'endpoint-a' },
            connectionDescriptorRevision: 7,
        });
        const credentials = { token: 'scoped-token', secret: 'scoped-secret' };
        mockTokenStorage(credentials);
        const { syncSwitchServer } = mockSyncInfra();
        const syncRestore = vi.fn(async () => undefined);
        const syncHydrateLocalState = vi.fn();
        vi.doMock('@/sync/sync', () => ({ syncSwitchServer, syncRestore, syncHydrateLocalState }));
        vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
            getIrohHomeTunnelRuntime: () => irohRuntimeMock,
        }));
        vi.doMock('@/sync/runtime/nativeLoopbackTunnels/runtime', () => ({
            startNativeLoopbackTunnelRuntimeAppStateLifecycle: startLifecycleSpy,
        }));
        let releaseCarrier!: () => void;
        const carrierGate = new Promise<void>((resolve) => {
            releaseCarrier = resolve;
        });
        const defaultEnsure = irohRuntimeMock.ensureHomeTunnel.getMockImplementation()!;
        irohRuntimeMock.ensureHomeTunnel.mockImplementationOnce(async () => {
            await carrierGate;
            return await defaultEnsure();
        });

        const { restoreConnectionToActiveServer, switchConnectionToActiveServer } = await import('./connectionManager');
        const restore = restoreConnectionToActiveServer(credentials);
        const switched = switchConnectionToActiveServer();
        await Promise.resolve();
        await Promise.resolve();
        releaseCarrier();
        await restore;
        await expect(switched).resolves.toEqual(credentials);

        // One carrier acquisition and one Sync initialization: the switch joined the
        // restore's applied runtime instead of racing a second bootstrap beside it.
        expect(irohRuntimeMock.ensureHomeTunnel).toHaveBeenCalledTimes(1);
        expect(syncRestore).toHaveBeenCalledTimes(1);
        expect(syncSwitchServer).not.toHaveBeenCalled();
    });

    it('hydrates the same-scope warm state even when cold restore cannot acquire the Iroh carrier', async () => {
        mockActiveSnapshot({
            serverId: 'srv_home_a',
            serverUrl: 'http://127.0.0.1:3010',
            generation: 43,
        });
        mockProfile({
            id: 'profile-a',
            serverIdentityId: 'srv_home_a',
            serverUrl: 'http://127.0.0.1:3010',
            irohEndpoint: { endpointId: 'endpoint-a' },
            connectionDescriptorRevision: 7,
        });
        const credentials = { token: 'scoped-token', secret: 'scoped-secret' };
        mockTokenStorage(credentials);
        const { syncSwitchServer } = mockSyncInfra();
        const syncRestore = vi.fn(async () => undefined);
        const syncHydrateLocalState = vi.fn();
        vi.doMock('@/sync/sync', () => ({ syncSwitchServer, syncRestore, syncHydrateLocalState }));
        vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
            getIrohHomeTunnelRuntime: () => irohRuntimeMock,
        }));
        vi.doMock('@/sync/runtime/nativeLoopbackTunnels/runtime', () => ({
            startNativeLoopbackTunnelRuntimeAppStateLifecycle: startLifecycleSpy,
        }));
        irohRuntimeMock.ensureHomeTunnel.mockRejectedValueOnce(new Error('home unreachable'));

        const { restoreConnectionToActiveServer, isColdActiveServerRestorePending,
            subscribeColdActiveServerRestore } = await import('./connectionManager');
        const restoreStates: boolean[] = [];
        const unsubscribe = subscribeColdActiveServerRestore(() => {
            restoreStates.push(isColdActiveServerRestorePending());
        });
        await expect(restoreConnectionToActiveServer(credentials)).rejects.toBeTruthy();
        expect(isColdActiveServerRestorePending()).toBe(false);
        expect(restoreStates).toEqual([true, false]);
        unsubscribe();

        expect(syncHydrateLocalState).toHaveBeenCalledWith(
            credentials,
            expect.objectContaining({ serverId: 'srv_home_a', generation: 43 }),
        );
        expect(syncRestore).not.toHaveBeenCalled();
    });

    it('keeps a non-Iroh Home on the established path and releases stale Iroh leases', async () => {
        mockActiveSnapshot({
            serverId: 'srv_home_plain',
            serverUrl: 'https://plain.example.test',
            kind: 'custom',
            generation: 8,
        });
        mockProfile({
            id: 'profile-plain',
            serverIdentityId: 'srv_home_plain',
            serverUrl: 'https://plain.example.test',
        });
        mockTokenStorage({ token: 'plain-token', secret: 'plain-secret' });
        const { syncSwitchServer } = mockSyncInfra();
        vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
            getIrohHomeTunnelRuntime: () => irohRuntimeMock,
        }));
        vi.doMock('@/sync/runtime/nativeLoopbackTunnels/runtime', () => ({
            startNativeLoopbackTunnelRuntimeAppStateLifecycle: startLifecycleSpy,
        }));

        const { switchConnectionToActiveServer } = await import('./connectionManager');
        await switchConnectionToActiveServer();

        expect(irohRuntimeMock.ensureHomeTunnel).not.toHaveBeenCalled();
        expect(startLifecycleSpy).not.toHaveBeenCalled();
        expect(irohRuntimeMock.releaseLeasesForStaleTargets).toHaveBeenCalledTimes(1);
        expect(syncSwitchServer).toHaveBeenCalledWith(
            { token: 'plain-token', secret: 'plain-secret' },
            expect.objectContaining({
                serverId: 'srv_home_plain',
                serverUrl: 'https://plain.example.test',
                generation: 8,
            }),
        );
    });

    // Without an independently trusted HTTPS endpoint, even failures eligible
    // for initial-selection fallback cannot publish a transport or reach Sync.
    // Identity/auth/integrity refusals retain their original error instead.
    const failClosedFailures: ReadonlyArray<Readonly<{
        name: string;
        failure: unknown;
        transportUnavailable?: true;
    }>> = [
        { name: 'authenticated ping denial', failure: new Error('iroh_home_tunnel_probe_failed:auth-failed') },
        { name: 'probe identity mismatch', failure: new Error('iroh_home_tunnel_probe_failed:identity-mismatch') },
        { name: 'features probe unavailable', failure: new Error('iroh_home_tunnel_probe_failed:features-unavailable'), transportUnavailable: true },
        { name: 'native identity mismatch', failure: new IrohError('identity_mismatch', 'native lease does not match the requested Home identity') },
        { name: 'invalid descriptor', failure: new IrohError('invalid_descriptor', 'descriptor rejected') },
        { name: 'invalid preamble', failure: new IrohError('invalid_preamble', 'bad preamble byte'), transportUnavailable: true },
        { name: 'unsupported ALPN', failure: new IrohError('unsupported_alpn', 'ALPN rejected'), transportUnavailable: true },
        { name: 'endpoint config conflict', failure: new IrohError('endpoint_config_conflict', 'endpoint config conflict'), transportUnavailable: true },
        { name: 'invalid endpoint input', failure: new Error('iroh_home_tunnel_invalid_endpoint') },
        { name: 'stale generation', failure: new Error('iroh_home_tunnel_stale_generation') },
        { name: 'stale focus', failure: new Error('iroh_home_tunnel_stale_focus') },
        { name: 'native transport loss', failure: new IrohError('transport', 'transport closed'), transportUnavailable: true },
        { name: 'health unreachability', failure: new Error('iroh_home_tunnel_probe_failed:health-unavailable'), transportUnavailable: true },
        { name: 'bounded probe timeout', failure: new Error('iroh_home_tunnel_probe_failed:probe-timeout'), transportUnavailable: true },
        { name: 'unknown native failure (not a typed auth refusal)', failure: new Error('iroh relay admission rejected'), transportUnavailable: true },
    ];

    it.each(failClosedFailures)('fails closed on $name and never switches to the unsafe target', async ({ failure, transportUnavailable }) => {
        mockActiveSnapshot({
            serverId: 'srv_home_a',
            serverUrl: 'https://iroh-fail.example.test',
            kind: 'custom',
            generation: 9,
        });
        mockProfile({
            id: 'profile-a',
            serverIdentityId: 'srv_home_a',
            serverUrl: 'https://iroh-fail.example.test',
            irohEndpoint: { endpointId: 'endpoint-a' },
            connectionDescriptorRevision: 2,
        });
        mockTokenStorage({ token: 'scoped-token', secret: 'scoped-secret' });
        const { syncSwitchServer } = mockSyncInfra();
        const ensureHomeTunnel = vi.fn(async () => {
            throw failure;
        });
        vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
            getIrohHomeTunnelRuntime: () => ({
                ...irohRuntimeMock,
                ensureHomeTunnel,
            }),
        }));
        vi.doMock('@/sync/runtime/nativeLoopbackTunnels/runtime', () => ({
            startNativeLoopbackTunnelRuntimeAppStateLifecycle: startLifecycleSpy,
        }));

        const { switchConnectionToActiveServer } = await import('./connectionManager');
        if (transportUnavailable) {
            const { ServerScopedTransportUnavailableError } = await import('@/sync/runtime/homeCarrier');
            await expect(switchConnectionToActiveServer()).rejects.toBeInstanceOf(ServerScopedTransportUnavailableError);
        } else {
            await expect(switchConnectionToActiveServer()).rejects.toBe(failure);
        }

        expect(ensureHomeTunnel).toHaveBeenCalledTimes(1);
        expect(publishActiveServerRuntimeOriginSpy).not.toHaveBeenCalled();
        expect(syncSwitchServer).not.toHaveBeenCalled();
    });

    /** The declared origin at the fetch boundary, recording every credential it receives. */
    async function serveDeclaredHome(serverIdentityId: string): Promise<Array<string | null>> {
        const authorizations: Array<string | null> = [];
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(async (input, init) => {
            authorizations.push(new Headers(init?.headers).get('Authorization'));
            return new Response(JSON.stringify(String(input).endsWith('/v1/features')
                ? { features: {}, capabilities: { serverIdentity: { serverIdentityId } } }
                : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        return authorizations;
    }

    // Only safe pre-acquisition unavailability may hand initial selection to
    // descriptor-proven HTTPS ingress, which must then prove the same Home.
    const fallbackAllowedFailures: ReadonlyArray<Readonly<{ name: string; failure: unknown }>> = [
        { name: 'native unavailability', failure: new IrohError('unavailable', 'Native Iroh transport is unavailable.') },
        { name: 'suspended runtime', failure: new Error('iroh_home_tunnel_suspended') },
    ];

    it.each(fallbackAllowedFailures)('uses descriptor-proven HTTPS ingress for $name', async ({ failure }) => {
        mockActiveSnapshot({
            serverId: 'srv_home_a',
            serverUrl: 'https://iroh-fail.example.test',
            kind: 'custom',
            generation: 9,
        });
        mockProfile({
            id: 'profile-a',
            serverIdentityId: 'srv_home_a',
            serverUrl: 'https://iroh-fail.example.test',
            publicServerUrl: 'https://public-iroh-fail.example.test',
            irohEndpoint: { endpointId: 'endpoint-a' },
            connectionDescriptorRevision: 2,
        });
        mockTokenStorage({ token: 'scoped-token', secret: 'scoped-secret' });
        const { syncSwitchServer } = mockSyncInfra();
        const ensureHomeTunnel = vi.fn(async () => {
            throw failure;
        });
        vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
            getIrohHomeTunnelRuntime: () => ({
                ...irohRuntimeMock,
                ensureHomeTunnel,
            }),
        }));
        vi.doMock('@/sync/runtime/nativeLoopbackTunnels/runtime', () => ({
            startNativeLoopbackTunnelRuntimeAppStateLifecycle: startLifecycleSpy,
        }));
        await serveDeclaredHome('srv_home_a');

        const { switchConnectionToActiveServer } = await import('./connectionManager');
        await expect(switchConnectionToActiveServer()).resolves.toEqual({ token: 'scoped-token', secret: 'scoped-secret' });

        expect(ensureHomeTunnel).toHaveBeenCalledTimes(1);
        expect(syncSwitchServer).toHaveBeenCalledTimes(1);
        expect(syncSwitchServer).toHaveBeenCalledWith(
            { token: 'scoped-token', secret: 'scoped-secret' },
            expect.objectContaining({
                serverId: 'srv_home_a',
                serverUrl: 'https://iroh-fail.example.test',
                generation: 9,
            }),
        );
    });

    it('publishes the canonical independent HTTPS fallback origin', async () => {
        mockActiveSnapshot({
            serverId: 'srv_home_a',
            serverUrl: 'https://iroh-fail.example.test',
            kind: 'custom',
            generation: 9,
        });
        mockProfile({
            id: 'profile-a',
            serverIdentityId: 'srv_home_a',
            serverUrl: 'https://iroh-fail.example.test',
            publicServerUrl: ' HTTPS://Public.Example.test:443/api///?token=secret#fragment ',
            irohEndpoint: { endpointId: 'endpoint-a' },
            connectionDescriptorRevision: 2,
        });
        mockTokenStorage({ token: 'scoped-token', secret: 'scoped-secret' });
        mockSyncInfra();
        vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
            getIrohHomeTunnelRuntime: () => ({
                ...irohRuntimeMock,
                ensureHomeTunnel: vi.fn(async () => {
                    throw new IrohError('unavailable', 'Native Iroh transport is unavailable.');
                }),
            }),
        }));
        vi.doMock('@/sync/runtime/nativeLoopbackTunnels/runtime', () => ({
            startNativeLoopbackTunnelRuntimeAppStateLifecycle: startLifecycleSpy,
        }));
        await serveDeclaredHome('srv_home_a');

        const { switchConnectionToActiveServer } = await import('./connectionManager');
        await switchConnectionToActiveServer();

        expect(publishActiveServerRuntimeOriginSpy).toHaveBeenCalledWith(expect.objectContaining({
            runtimeOrigin: 'https://public.example.test/api',
            carrier: 'https',
        }));
    });

    it('publishes nothing and sends no credential when a cold start falls back to a different Home', async () => {
        mockActiveSnapshot({
            serverId: 'srv_home_a',
            serverUrl: 'https://iroh-fail.example.test',
            kind: 'custom',
            generation: 9,
        });
        mockProfile({
            id: 'profile-a',
            serverIdentityId: 'srv_home_a',
            serverUrl: 'https://iroh-fail.example.test',
            publicServerUrl: 'https://public-iroh-fail.example.test',
            irohEndpoint: { endpointId: 'endpoint-a' },
            connectionDescriptorRevision: 2,
        });
        mockTokenStorage({ token: 'scoped-token', secret: 'scoped-secret' });
        const { syncSwitchServer } = mockSyncInfra();
        vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
            getIrohHomeTunnelRuntime: () => ({
                ...irohRuntimeMock,
                ensureHomeTunnel: vi.fn(async () => {
                    throw new IrohError('home_unreachable', 'relay outage');
                }),
            }),
        }));
        vi.doMock('@/sync/runtime/nativeLoopbackTunnels/runtime', () => ({
            startNativeLoopbackTunnelRuntimeAppStateLifecycle: startLifecycleSpy,
        }));
        const authorizations = await serveDeclaredHome('srv_reassigned_home');

        const { switchConnectionToActiveServer } = await import('./connectionManager');
        await expect(switchConnectionToActiveServer()).rejects.toThrow();

        expect(authorizations).toEqual([null]);
        expect(publishActiveServerRuntimeOriginSpy).not.toHaveBeenCalled();
        expect(syncSwitchServer).not.toHaveBeenCalled();
    });

    it('fails typed when Iroh is unavailable and the descriptor proves no independent HTTPS ingress', async () => {
        mockActiveSnapshot({
            serverId: 'srv_home_a',
            serverUrl: 'http://127.0.0.1:3010',
            kind: 'custom',
            generation: 10,
        });
        mockProfile({
            id: 'profile-a',
            serverIdentityId: 'srv_home_a',
            serverUrl: 'http://127.0.0.1:3010',
            publicServerUrl: null,
            irohEndpoint: { endpointId: 'endpoint-a' },
            connectionDescriptorRevision: 2,
        });
        mockTokenStorage({ token: 'scoped-token', secret: 'scoped-secret' });
        const { syncSwitchServer } = mockSyncInfra();
        vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
            getIrohHomeTunnelRuntime: () => ({
                ...irohRuntimeMock,
                ensureHomeTunnel: vi.fn(async () => {
                    throw new IrohError('unavailable', 'Native Iroh transport is unavailable.');
                }),
            }),
        }));
        vi.doMock('@/sync/runtime/nativeLoopbackTunnels/runtime', () => ({
            startNativeLoopbackTunnelRuntimeAppStateLifecycle: startLifecycleSpy,
        }));

        const { switchConnectionToActiveServer } = await import('./connectionManager');
        await expect(switchConnectionToActiveServer()).rejects.toMatchObject({
            name: 'ServerScopedTransportUnavailableError',
        });
        expect(syncSwitchServer).not.toHaveBeenCalled();
    });

    it('never switches to a stale target while a later explicitly requested current generation switches normally', async () => {
        let generation = 9;
        let ensureOutcome: 'stale' | 'verified' = 'stale';
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'srv_home_a',
                serverUrl: 'https://iroh-stale.example.test',
                kind: 'custom',
                generation,
            }),
            captureActiveServerRuntimeTarget: () => ({
                serverId: 'srv_home_a',
                generation,
            }),
            getActiveServerHomeCarrier: () => undefined,
            publishActiveServerRuntimeOrigin: publishActiveServerRuntimeOriginSpy,
            releaseActiveServerRuntimeOrigin: vi.fn(),
        }));
        mockProfile({
            id: 'profile-a',
            serverIdentityId: 'srv_home_a',
            serverUrl: 'https://iroh-stale.example.test',
            irohEndpoint: { endpointId: 'endpoint-a' },
            connectionDescriptorRevision: 2,
        });
        mockTokenStorage({ token: 'scoped-token', secret: 'scoped-secret' });
        const { syncSwitchServer } = mockSyncInfra();
        const ensureHomeTunnel = vi.fn(async () => {
            if (ensureOutcome === 'stale') throw new Error('iroh_home_tunnel_stale_focus');
            return {
                leaseId: 'iroh-home:test',
                key: 'test',
                remoteHostId: 'srv_home_a',
                localUrl: 'http://127.0.0.1:46103',
                channelMode: 'loopback-port',
                purpose: 'home',
                status: 'ready',
                startedAt: '2026-08-30T00:00:00.000Z',
                homeServerIdentityId: 'srv_home_a',
                endpointId: 'endpoint-a',
                carrier: 'iroh',
                observedPath: 'direct',
            };
        });
        vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
            getIrohHomeTunnelRuntime: () => ({
                ...irohRuntimeMock,
                ensureHomeTunnel,
            }),
        }));
        vi.doMock('@/sync/runtime/nativeLoopbackTunnels/runtime', () => ({
            startNativeLoopbackTunnelRuntimeAppStateLifecycle: startLifecycleSpy,
        }));

        const { switchConnectionToActiveServer } = await import('./connectionManager');

        // The stale/unsafe target is rejected before `syncSwitchServer` runs.
        await expect(switchConnectionToActiveServer()).rejects.toThrow('iroh_home_tunnel_stale_focus');
        expect(syncSwitchServer).not.toHaveBeenCalled();

        // A later explicit request for the now-current generation runs through
        // the normal owner path; no switch retry machinery exists or is needed.
        ensureOutcome = 'verified';
        generation = 10;
        await expect(switchConnectionToActiveServer()).resolves.toEqual({ token: 'scoped-token', secret: 'scoped-secret' });
        expect(syncSwitchServer).toHaveBeenCalledTimes(1);
        expect(syncSwitchServer).toHaveBeenCalledWith(
            { token: 'scoped-token', secret: 'scoped-secret' },
            expect.objectContaining({
                serverId: 'srv_home_a',
                serverUrl: 'https://iroh-stale.example.test',
                generation: 10,
            }),
        );
    });

    it('does not acquire or retry through Home A after focus changes while its credentials are loading', async () => {
        let activeSnapshot = {
            serverId: 'srv_home_a',
            serverUrl: 'https://home-a.example.test',
            kind: 'custom',
            generation: 11,
        };
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => activeSnapshot,
            captureActiveServerRuntimeTarget: () => ({
                serverId: activeSnapshot.serverId,
                generation: activeSnapshot.generation,
            }),
            getActiveServerHomeCarrier: () => undefined,
            publishActiveServerRuntimeOrigin: publishActiveServerRuntimeOriginSpy,
            releaseActiveServerRuntimeOrigin: vi.fn(),
        }));
        vi.doMock('@/sync/domains/server/serverProfiles', () => ({
            getServerProfileById: (serverId: string) => serverId === 'srv_home_a'
                ? buildExactIrohProfileFixture({
                    id: 'profile-a',
                    serverIdentityId: 'srv_home_a',
                    serverUrl: 'https://home-a.example.test',
                    irohEndpoint: { endpointId: 'endpoint-a' },
                    connectionDescriptorRevision: 2,
                })
                : buildExactIrohProfileFixture({
                    id: 'profile-b',
                    serverIdentityId: 'srv_home_b',
                    serverUrl: 'https://home-b.example.test',
                }),
        }));
        let resolveCredentials: ((value: { token: string; secret: string }) => void) | null = null;
        vi.doMock('@/auth/storage/tokenStorage', async (importOriginal) => await createTokenStorageModuleMock({
            importOriginal,
            tokenStorage: {
                getCredentialsForServerUrl: vi.fn(async (serverUrl: string) => serverUrl === 'https://home-b.example.test'
                    ? { token: 'token-b', secret: 'secret-b' }
                    : await new Promise<{ token: string; secret: string }>((resolve) => {
                        resolveCredentials = resolve;
                    })),
            },
        }));
        const { retryNow } = mockSyncInfra();
        vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
            getIrohHomeTunnelRuntime: () => irohRuntimeMock,
        }));
        vi.doMock('@/sync/runtime/nativeLoopbackTunnels/runtime', () => ({
            startNativeLoopbackTunnelRuntimeAppStateLifecycle: startLifecycleSpy,
        }));

        const { retryActiveServerConnection } = await import('./connectionManager');
        const retry = retryActiveServerConnection();
        await vi.waitFor(() => expect(resolveCredentials).toBeTypeOf('function'));
        activeSnapshot = {
            serverId: 'srv_home_b',
            serverUrl: 'https://home-b.example.test',
            kind: 'custom',
            generation: 12,
        };
        resolveCredentials!({ token: 'token-a', secret: 'secret-a' });

        await expect(retry).resolves.toBeUndefined();
        expect(irohRuntimeMock.ensureHomeTunnel).not.toHaveBeenCalled();
        expect(publishActiveServerRuntimeOriginSpy).not.toHaveBeenCalled();
        expect(retryNow).not.toHaveBeenCalled();
    });

    it('does not acquire Iroh without an endpoint-scoped credential to verify with', async () => {
        mockActiveSnapshot({
            serverId: 'srv_home_a',
            serverUrl: 'https://iroh-noauth.example.test',
            kind: 'custom',
            generation: 10,
        });
        mockProfile({
            id: 'profile-a',
            serverIdentityId: 'srv_home_a',
            serverUrl: 'https://iroh-noauth.example.test',
            irohEndpoint: { endpointId: 'endpoint-a' },
        });
        mockTokenStorage(null);
        const { syncSwitchServer } = mockSyncInfra();
        vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
            getIrohHomeTunnelRuntime: () => irohRuntimeMock,
        }));
        vi.doMock('@/sync/runtime/nativeLoopbackTunnels/runtime', () => ({
            startNativeLoopbackTunnelRuntimeAppStateLifecycle: startLifecycleSpy,
        }));

        const { switchConnectionToActiveServer } = await import('./connectionManager');
        await switchConnectionToActiveServer();

        expect(irohRuntimeMock.ensureHomeTunnel).not.toHaveBeenCalled();
        expect(startLifecycleSpy).not.toHaveBeenCalled();
        expect(syncSwitchServer).toHaveBeenCalledTimes(1);
    });

    it('releases the focused Iroh publication before disconnecting Sync', async () => {
        mockActiveSnapshot({
            serverId: 'srv_home_a',
            serverUrl: 'http://127.0.0.1:3010',
            generation: 10,
        });
        mockProfile({
            id: 'profile-a',
            serverIdentityId: 'srv_home_a',
            serverUrl: 'http://127.0.0.1:3010',
            irohEndpoint: { endpointId: 'endpoint-a' },
        });
        mockTokenStorage(null);
        const { syncSwitchServer } = mockSyncInfra();
        vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
            getIrohHomeTunnelRuntime: () => irohRuntimeMock,
        }));
        vi.doMock('@/sync/runtime/nativeLoopbackTunnels/runtime', () => ({
            startNativeLoopbackTunnelRuntimeAppStateLifecycle: startLifecycleSpy,
        }));

        const { switchConnectionToActiveServer } = await import('./connectionManager');
        await switchConnectionToActiveServer();

        expect(irohRuntimeMock.releaseActiveHomeTunnels).toHaveBeenCalledTimes(1);
        expect(irohRuntimeMock.releaseActiveHomeTunnels.mock.invocationCallOrder[0])
            .toBeLessThan(syncSwitchServer.mock.invocationCallOrder[0]);
        expect(syncSwitchServer).toHaveBeenCalledWith(
            null,
            expect.objectContaining({
                serverId: 'srv_home_a',
                serverUrl: 'http://127.0.0.1:3010',
                generation: 10,
            }),
        );
    });

    it('disconnects explicitly after first-key authority is cleared even while recovery storage retains credentials', async () => {
        mockActiveSnapshot({
            serverId: 'srv_home_a',
            serverUrl: 'http://127.0.0.1:3010',
            generation: 11,
        });
        mockProfile({
            id: 'profile-a',
            serverIdentityId: 'srv_home_a',
            serverUrl: 'http://127.0.0.1:3010',
            irohEndpoint: { endpointId: 'endpoint-a' },
        });
        mockTokenStorage({ token: 'recovery-custody-token', secret: 'recovery-secret' });
        const { syncSwitchServer } = mockSyncInfra();
        vi.doMock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
            getIrohHomeTunnelRuntime: () => irohRuntimeMock,
        }));
        vi.doMock('@/sync/runtime/nativeLoopbackTunnels/runtime', () => ({
            startNativeLoopbackTunnelRuntimeAppStateLifecycle: startLifecycleSpy,
        }));

        const { disconnectActiveServerConnection } = await import('./connectionManager');
        await disconnectActiveServerConnection();

        expect(irohRuntimeMock.ensureHomeTunnel).not.toHaveBeenCalled();
        expect(irohRuntimeMock.releaseActiveHomeTunnels).toHaveBeenCalledTimes(1);
        expect(irohRuntimeMock.releaseActiveHomeTunnels.mock.invocationCallOrder[0])
            .toBeLessThan(syncSwitchServer.mock.invocationCallOrder[0]);
        expect(syncSwitchServer).toHaveBeenCalledWith(null);
    });
});
