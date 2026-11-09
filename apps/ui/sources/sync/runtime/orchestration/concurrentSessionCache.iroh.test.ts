import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    SessionCurrentProjectionRecordV1Schema} from '@happier-dev/protocol/sessions/listing/response';
import { type HomeConnectionDescriptorV1,
} from '@happier-dev/protocol/auth/accountDirectory';

import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';

const HOME_B = 'https://iroh-home-b.example.test';
const ORIGIN = 'http://127.0.0.1:45991';
const descriptor: HomeConnectionDescriptorV1 = {
    v: 1, homeServerIdentityId: 'srv_home_b', canonicalServerUrl: HOME_B, revision: 7,
    endpoints: [{ kind: 'iroh', endpointId: 'b'.repeat(64), relayUrls: ['https://relay.example.test'] }],
};
let cleanup: (() => Promise<void>) | null = null;

async function installHarness(options: { additionalHome?: boolean; failIdentity?: boolean } = {}) {
    const io = vi.fn();
    const sockets: Array<ReturnType<typeof createSocketIoBoundaryStub>> = [];
    const starts: Array<Record<string, unknown>> = [];
    const stops: string[] = [];
    const closedNativeLeases = new Set<string>();
    let heldStart: Promise<void> | null = null;
    let failIdentity = options.failIdentity ?? false;
    const secureValues = new Map<string, string>();
    // Native lifecycle and device credential storage are genuine host boundaries;
    // the native adapter, lease supervisor, identity probes and cache stay real.
    vi.stubGlobal('__TAURI_INTERNALS__', {
        invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_secure_storage_read') return secureValues.get(String(args?.key)) ?? null;
            if (command === 'desktop_secure_storage_write') { secureValues.set(String(args?.key), String(args?.value)); return null; }
            if (command === 'desktop_secure_storage_remove') { secureValues.delete(String(args?.key)); return null; }
            if (command === 'iroh_ensure_home_tunnel') {
                const request = args?.request;
                if (!request || typeof request !== 'object') throw new Error('Missing native Home request');
                const input = request as Record<string, unknown>;
                starts.push(input);
                if (heldStart) await heldStart;
                return {
                    leaseId: `native-home-${starts.length}`, homeServerIdentityId: input.homeServerIdentityId,
                    homeEndpointId: input.endpointId, runtimeOrigin: ORIGIN,
                    carrier: 'iroh', observedPath: 'relay', startedAtMs: Date.now(),
                };
            }
            if (command === 'iroh_release_home_tunnel') { stops.push(String(args?.leaseId)); return null; }
            if (command === 'iroh_get_tunnel_status') {
                return closedNativeLeases.has(String(args?.leaseId))
                    ? null : { active: true, connectionActive: true, observedPath: 'relay' };
            }
            throw new Error(`Unexpected native command: ${command}`);
        },
    });
    // Publish credentials only after the native device-store boundary exists;
    // installing Tauri later changes which real storage port TokenStorage reads.
    const network = await installSessionOpsNetworkBoundary();
    const homeA = await network.addHome('https://iroh-home-a.example.test', 'account-a');
    const homeB = await network.addHome(HOME_B, 'account-b');
    const homeC = options.additionalHome
        ? await network.addHome('https://iroh-home-c.example.test', 'account-c') : null;
    const profiles = await import('@/sync/domains/server/serverProfiles');
    await profiles.adoptHomeProfile({ descriptor, source: 'manual' });
    const homeBScope = profiles.resolveServerProfileScopeIdForIdentifier(homeB.id);
    await profiles.setActiveServerId(homeA.id, { scope: 'device' });
    await profiles.updateHomeViewState((state) => ({
        ...state,
        groups: [{ id: 'main', name: 'Main', serverIds: [homeA.id, homeBScope, ...(homeC ? [homeC.id] : [])], presentation: 'grouped' }],
        activeTargetKind: 'group', activeTargetId: 'main',
    }));
    network.setSocketConfigurator(boundary => {
        io(boundary.serverUrl, boundary.options);
        sockets.push(boundary);
    });
    const fetchedUrls: string[] = [];
    let sessions: string[] = [];
    let machines: string[] = [];
    let reconcileNumber = 0;
    let currentDescriptor = descriptor;
    let featureResponse: (() => Promise<Response>) | null = null;
    let pageResponse: ((url: URL) => Promise<Response | null>) | null = null;
    const features = () => createRootLayoutFeaturesResponse({
        capabilities: { serverIdentity: { serverIdentityId: failIdentity ? 'srv_wrong_home' : descriptor.homeServerIdentityId } },
        // Authenticated discovery describes the same adopted generation, not a
        // fabricated descriptor that would rotate the carrier on every refresh.
        homeConnectionDescriptor: currentDescriptor,
    });
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(createSessionReadBatchFetchBoundary(async (input) => {
        const url = new URL(String(input));
        fetchedUrls.push(url.href);
        if (![ORIGIN, homeA.serverUrl, HOME_B, ...(homeC ? [homeC.serverUrl] : [])].includes(url.origin)) {
            throw new Error(`Unexpected Home origin: ${url.origin}`);
        }
        if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({});
        if (url.pathname === '/v1/features') return Response.json(url.origin === ORIGIN ? features() : createRootLayoutFeaturesResponse());
        if (url.pathname === '/v1/features/authenticated') {
            if (url.origin !== ORIGIN) return Response.json(createRootLayoutFeaturesResponse());
            return featureResponse ? await featureResponse() : Response.json(features());
        }
        if (url.pathname === '/v1/account/encryption/currentness') {
            return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        }
        if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        if (url.pathname === '/v2/sessions') {
            const overridden = await pageResponse?.(url);
            if (overridden) return overridden;
            return Response.json({ sessions: sessions.map((id) => {
                const session = createSessionFixture({ id });
                const access = createSessionAccessFixture();
                return SessionCurrentProjectionRecordV1Schema.parse({
                    ...session, metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
                    ownerMetadata: { t: 'plain', v: { v: 1 } },
                    agentState: null, dataEncryptionKey: null, share: null, archivedAt: null,
                    effectiveAccess: { v: 1, level: access.level, sources: [{ kind: 'owner' }], capabilities: access.capabilities },
                    viewer: {
                        latestFailureSeq: null,
                        readState: { state: 'not_started' }, relevance: { relevant: false, reasons: [] },
                        attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                        follow: { follows: false, notificationLevel: 'none' },
                        notification: { level: 'none', source: 'preference' },
                    },
                    responsibleAccountId: null, responsibleAccount: null,
                });
            }), nextCursor: null, hasNext: false });
        }
        // A retained row omitted by the refreshed head needs the real exact
        // access read, not an indistinguishable missing-route 404.
        if (url.pathname.startsWith('/v2/sessions/')) {
            return Response.json({ error: 'Session not found' }, { status: 404 });
        }
        if (url.pathname === '/v1/machines') {
            const accountId = url.origin === ORIGIN ? homeB.accountId
                : url.origin === homeA.serverUrl ? homeA.accountId : homeC?.accountId;
            if (!accountId) throw new Error('Machine census has no fixture Account');
            return Response.json(machines.map(id => createPlainMachineRowFixture({ id, accountId })));
        }
        return Response.json({}, { status: 404 });
    }));
    // Exact removal delegates to the real Sync lifetime owner through its
    // Node require bridge, just as the canonical concurrent-cache harness does.
    const bridge = await loadSyncSingletonForTests();
    const pool = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    pool.setServerReachabilityNetworkAllowed(true);
    const cache = await import('./concurrentSessionCache');
    const { storage } = await import('@/sync/domains/state/storageStore');
    cleanup = async () => {
        cache.stopConcurrentSessionCacheSync();
        await vi.advanceTimersByTimeAsync(1);
        await pool.resetServerReachabilitySupervisors();
        await (await import('@/sync/runtime/nativeIrohTunnels/runtime')).disposeIrohHomeTunnelRuntime();
        (await import('@/sync/api/capabilities/serverFeaturesClient')).resetServerFeaturesClientForTests();
        await network.dispose();
        for (const home of [homeB, homeA, ...(homeC ? [homeC] : [])]) {
            const profile = profiles.getServerProfileById(home.id);
            if (profile) await profiles.removeServerProfile(profile.id);
        }
        storage.getState().clearSessionListRowsForServerScope(homeBScope);
        bridge.dispose();
    };
    return {
        ...cache, network, profiles, homeB, homeC, homeBScope, storage, starts, stops, io, sockets, fetchedUrls, pool,
        holdStart(promise: Promise<void>) { heldStart = promise; },
        failIdentity(value: boolean) { failIdentity = value; },
        setRows(sessionIds: string[], machineIds: string[]) { sessions = sessionIds; machines = machineIds; },
        holdFeatures(responder: (() => Promise<Response>) | null) { featureResponse = responder; },
        servePage(responder: (url: URL) => Promise<Response | null>) { pageResponse = responder; },
        closeNativeLease() { closedNativeLeases.add('native-home-1'); },
        async reconcile() { await profiles.upsertServerProfile({ serverUrl: HOME_B, name: `Home B ${++reconcileNumber}` }); await vi.advanceTimersByTimeAsync(1); },
        async changeEndpoint() {
            currentDescriptor = { ...descriptor, revision: 8,
                endpoints: [{ kind: 'iroh', endpointId: 'c'.repeat(64), relayUrls: ['https://relay.example.test'] }] };
            await profiles.adoptHomeProfile({
                descriptor: currentDescriptor,
                source: 'manual',
            });
            await vi.advanceTimersByTimeAsync(1);
        },
        async settle() { await vi.advanceTimersByTimeAsync(601); },
        projection() {
            const state = storage.getState();
            return {
                status: state.machineListStatusByServerId[homeBScope],
                sessionIds: state.ordinarySessionListMembershipByServerId[homeBScope] ?? [],
                machineIds: state.machineListByServerId[homeBScope]?.map((m) => m.id) ?? [],
            };
        },
    };
}

async function resetHarness(): Promise<void> {
    await cleanup?.();
    cleanup = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
}

// Load the real Sync graph only after installing its native/network ports.
// Cold transforms exceeded a case's deadline before its race even started;
// collect them once and retire resources through their real lifecycle owners.
vi.useFakeTimers();
try {
    await installHarness();
} finally {
    await resetHarness();
}

beforeEach(() => {
    vi.useFakeTimers();
    process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
});
afterEach(resetHarness);

describe('concurrent session cache Iroh Home routing', () => {
    it('starts a fresh page after same-Account carrier replacement before the replacement socket connects', async () => {
        const h = await installHarness();
        h.startConcurrentSessionCacheSync();
        await h.settle();
        await vi.waitFor(() => expect(h.storage.getState().concurrentSessionListCacheByServerId[h.homeBScope]?.listObservation?.phase)
            .toBe('ready'));
        const { fetchSessionListQueryPageForHome } = await import('@/sync/domains/session/listing/sessionListQueryRuntime');
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let pageReads = 0;
        h.servePage(async url => {
            if (url.searchParams.get('cursor') !== 'carrier-replacement-page') return null;
            if (++pageReads === 1) await held;
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        });
        const page = { source: { kind: 'ordinary' as const, path: '/v2/sessions', allowV1Fallback: false },
            membership: 'rowOnly' as const, cursor: 'carrier-replacement-page', signal: new AbortController().signal };
        const older = fetchSessionListQueryPageForHome(h.homeBScope, page);
        let newer: ReturnType<typeof fetchSessionListQueryPageForHome> | undefined;
        try {
            await vi.waitFor(() => expect(pageReads).toBe(1));
            h.network.setSocketConfigurator(boundary => {
                // A verified HTTP carrier can become online before Socket.IO connects.
                // Hold only that external connect event, not the runtime/reachability owners.
                boundary.socket.connect.mockImplementation(() => { boundary.socket.active = true; });
            });
            await h.changeEndpoint();
            await h.settle();
            await vi.waitFor(() => expect(h.network.socketBoundaries).toHaveLength(2));
            expect(h.network.socketBoundaries[1]!.socket.connected).toBe(false);
            expect(h.getConcurrentSessionListQueryHomeAvailability(h.homeBScope)).toBe('online');
            newer = fetchSessionListQueryPageForHome(h.homeBScope, { ...page, signal: new AbortController().signal });
            await vi.waitFor(() => expect(pageReads).toBe(2));
            await expect(newer).resolves.toMatchObject({ current: true, sessionIds: [] });
            release();
            await expect(older).resolves.toMatchObject({ current: false });
        } finally {
            release();
            await Promise.allSettled([older, ...(newer ? [newer] : [])]);
        }
    });

    it('starts an independent secondary Home while another Home transport acquisition is held', async () => {
        const h = await installHarness({ additionalHome: true });
        let finish!: () => void;
        h.holdStart(new Promise<void>((resolve) => { finish = resolve; }));
        h.startConcurrentSessionCacheSync();
        await vi.advanceTimersByTimeAsync(1);
        await vi.waitFor(() => expect(h.io).toHaveBeenCalledWith(h.homeC!.serverUrl, expect.anything()));
        expect(h.starts).toHaveLength(1);
        expect(h.fetchedUrls.some((url) => url.startsWith(ORIGIN))).toBe(false);
        finish();
        await h.settle();
    });

    it('does not stop a retained secondary Home when an older feature refresh settles after a newer reconcile', async () => {
        const h = await installHarness();
        let finish!: () => void;
        h.holdFeatures(() => new Promise<Response>((resolve) => {
            finish = () => resolve(Response.json(createRootLayoutFeaturesResponse({
                capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } }, homeConnectionDescriptor: descriptor,
            })));
        }));
        h.startConcurrentSessionCacheSync();
        await vi.advanceTimersByTimeAsync(1);
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        await h.reconcile();
        finish();
        await h.settle();
        await h.reconcile();

        expect(h.starts).toHaveLength(1);
        expect(h.stops).toEqual([]);
        expect(h.pool.peekServerReachabilityState(HOME_B, h.homeB.token)?.phase).toBe('online');
    });

    it('acquires before use and routes reachability, HTTP, and WebSocket-only Socket.IO through one runtime origin', async () => {
        const h = await installHarness();
        h.startConcurrentSessionCacheSync();
        await h.settle();
        await vi.waitFor(() => expect(h.fetchedUrls).toContain(`${ORIGIN}/v1/machines?includeRevoked=true`));
        expect(h.starts).toEqual([{
            homeServerIdentityId: descriptor.homeServerIdentityId, endpointId: 'b'.repeat(64),
            policy: 'automatic', relayUrls: ['https://relay.example.test'],
        }]);
        expect(h.io).toHaveBeenCalledWith(ORIGIN, expect.objectContaining({ transports: ['websocket'] }));
        expect(h.fetchedUrls).toContain(`${ORIGIN}/v1/auth/ping`);
        expect(h.fetchedUrls).toContain(`${ORIGIN}/v1/features/authenticated`);
        expect(h.fetchedUrls.some((url) => url.startsWith(HOME_B))).toBe(false);
        h.pool.setServerReachabilityNetworkAllowed(false);
        h.pool.setServerReachabilityNetworkAllowed(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.starts).toHaveLength(1);
        await h.profiles.removeServerProfile(h.homeB.id);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.stops).toEqual(['native-home-1']);
    });

    it('does not bypass an identity-verification failure through HTTPS reachability, HTTP, or Socket.IO', async () => {
        const h = await installHarness({ failIdentity: true });
        h.startConcurrentSessionCacheSync();
        await h.settle();
        expect(h.starts.length).toBeGreaterThan(0);
        expect(h.io).not.toHaveBeenCalled();
        expect(h.fetchedUrls.some((url) => url.startsWith(HOME_B))).toBe(false);
        expect(h.fetchedUrls.some((url) => /\/v[12]\/(sessions|machines|features\/authenticated)/.test(url))).toBe(false);
        expect(h.projection().status).toBe('error');
    });

    it('drops a terminal secondary lease and reacquires it through the existing reconciliation owner', async () => {
        const h = await installHarness();
        h.startConcurrentSessionCacheSync();
        await h.settle();
        expect(h.starts).toHaveLength(1);
        h.closeNativeLease();
        // Native status polling owns the terminal fact; the fixture does not
        // call the cache's recovery callback or manufacture a runtime event.
        await vi.advanceTimersByTimeAsync(2_001);
        await vi.waitFor(() => expect(h.starts).toHaveLength(2));
        expect(h.stops).toContain('native-home-1');
        expect(h.pool.peekServerReachabilityState(HOME_B, h.homeB.token)?.phase).toBe('online');
    });
});

describe('concurrent session cache Iroh Home transport acquisition failure', () => {
    it('publishes an explicit target-local error status for a cold Home whose transport never resolved', async () => {
        const h = await installHarness({ failIdentity: true });
        h.startConcurrentSessionCacheSync();
        await h.settle();
        expect(h.projection()).toEqual({ status: 'error', sessionIds: [], machineIds: [] });
        expect(h.io).not.toHaveBeenCalled();
    });

    it('does not publish an acquisition error after a newer reconcile removed the Home', async () => {
        const h = await installHarness({ failIdentity: true });
        let finish!: () => void;
        h.holdStart(new Promise<void>((resolve) => { finish = resolve; }));
        h.startConcurrentSessionCacheSync();
        await vi.advanceTimersByTimeAsync(1);
        await vi.waitFor(() => expect(h.starts).toHaveLength(1));
        await h.profiles.removeServerProfile(h.homeB.id);
        await vi.advanceTimersByTimeAsync(1);
        finish();
        await h.settle();
        expect(h.projection().status).toBeUndefined();
        expect(h.io).not.toHaveBeenCalled();
        expect(h.stops).toEqual(['native-home-1']);
    });

    it('preserves last-known session and machine rows when a warm Home loses its transport', async () => {
        const h = await installHarness();
        h.setRows(['session-stale'], ['machine-stale']);
        h.startConcurrentSessionCacheSync();
        await h.settle();
        await vi.waitFor(() => expect(h.projection()).toEqual({
            status: 'idle', sessionIds: ['session-stale'], machineIds: ['machine-stale'],
        }));
        h.failIdentity(true);
        await h.changeEndpoint();
        await h.settle();

        expect(h.projection()).toEqual({ status: 'error', sessionIds: ['session-stale'], machineIds: ['machine-stale'] });
    });

    it('keeps another secondary Home healthy while one Home fails closed', async () => {
        const h = await installHarness({ failIdentity: true, additionalHome: true });
        h.setRows([], ['machine-c']);
        h.startConcurrentSessionCacheSync();
        await h.settle();
        await vi.waitFor(() => expect(h.storage.getState().machineListByServerId[h.homeC!.id]?.map((m) => m.id)).toEqual(['machine-c']));
        expect(h.storage.getState().machineListStatusByServerId[h.homeC!.id]).toBe('idle');
        expect(h.projection().status).toBe('error');
        expect(h.io).toHaveBeenCalledWith(h.homeC!.serverUrl, expect.anything());
        expect(h.fetchedUrls.some((url) => url.startsWith(HOME_B))).toBe(false);
    });

    it('reconciles a recovered Home to truthful current rows without duplicating preserved rows', async () => {
        const h = await installHarness();
        h.setRows(['session-stale'], ['machine-stale']);
        h.startConcurrentSessionCacheSync();
        await h.settle();
        await vi.waitFor(() => expect(h.projection().sessionIds).toEqual(['session-stale']));
        h.failIdentity(true);
        await h.changeEndpoint();
        await h.settle();
        expect(h.projection().status).toBe('error');
        h.failIdentity(false);
        h.setRows(['session-fresh'], ['machine-fresh']);
        await h.reconcile();
        await h.settle();

        await vi.waitFor(() => expect(h.projection()).toEqual({
            status: 'idle', sessionIds: ['session-fresh'], machineIds: ['machine-fresh'],
        }));
    });
});
