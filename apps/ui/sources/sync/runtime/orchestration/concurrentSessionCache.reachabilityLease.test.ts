import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';

let cleanup: (() => Promise<void>) | null = null;

async function installHarness(options: Readonly<{ includeMachineInventory?: boolean; realClock?: boolean;
    machineRows?: () => readonly ReturnType<typeof createPlainMachineRowFixture>[]; failingPing?: boolean }> = {}) {
    const network = await installSessionOpsNetworkBoundary();
    const homeA = await network.addHome('https://lease-a.example.test', 'account-a');
    const homeB = await network.addHome('https://lease-b.example.test', 'account-b');
    const profiles = await import('@/sync/domains/server/serverProfiles');
    await profiles.setActiveServerId(homeA.id, { scope: 'device' });
    await profiles.updateHomeViewState((state) => ({
        ...state,
        groups: [{ id: 'main', name: 'Main', serverIds: [homeA.id, homeB.id], presentation: 'grouped' }],
        activeTargetKind: 'group', activeTargetId: 'main',
    }));
    const socketModule = await import('socket.io-client');
    const io = vi.spyOn(socketModule, 'io');
    const pendingPings: Array<{ token: string | null; respond(): void }> = [];
    network.setHttpResponder(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/auth/ping' && options.failingPing) return new Response(null, { status: 503 });
        if (path === '/v1/auth/ping') {
            return await new Promise<Response>((resolve) => {
                pendingPings.push({
                    token: new Headers(init?.headers).get('authorization'),
                    respond: () => resolve(Response.json({})),
                });
            });
        }
        if (path === '/v1/features' || path === '/v1/features/authenticated') {
            return Response.json(createRootLayoutFeaturesResponse());
        }
        if (path === '/v1/account/encryption/currentness') {
            return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        }
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v2/sessions' || path === '/v2/sessions/active' || path === '/v2/sessions/attention') {
            return Response.json(V2SessionListResponseSchema.parse({ sessions: [], nextCursor: null, hasNext: false }));
        }
        if (path === '/v1/machines' && options.machineRows) return Response.json(options.machineRows());
        if (path === '/v1/machines' && !options.includeMachineInventory) return Response.json([]);
        return null;
    });
    const bridge = await loadSyncSingletonForTests();
    const pool = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    pool.setServerReachabilityNetworkAllowed(true);
    const cache = await import('./concurrentSessionCache');
    cleanup = async () => {
        cache.stopConcurrentSessionCacheSync();
        for (const ping of pendingPings) ping.respond();
        if (!options.realClock) await vi.advanceTimersByTimeAsync(1);
        await pool.resetServerReachabilitySupervisors();
        pool.setServerReachabilityNetworkAllowed(true);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await TokenStorage.removeCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id });
        await network.dispose();
        io.mockRestore();
        for (const home of [homeB, homeA]) {
            const profile = profiles.getServerProfileById(home.id);
            if (profile) await profiles.removeServerProfile(profile.id);
        }
        bridge.dispose();
    };
    cache.startConcurrentSessionCacheSync();
    if (!options.realClock) await vi.advanceTimersByTimeAsync(1);
    if (!options.failingPing) await vi.waitFor(() => expect(pendingPings).toHaveLength(1));
    return { ...cache, network, homeB, profiles, pool, pendingPings, io };
}

async function resetHarness(): Promise<void> {
    await cleanup?.();
    cleanup = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
}

// Compile the real Sync/cache graph after installing its transport ports, before
// the held-probe cases. Cold graph loading is not part of the lease race.
vi.useFakeTimers();
process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
try {
    await installHarness();
} finally {
    await resetHarness();
}

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
});
afterEach(resetHarness);

describe('concurrent session cache reachability lease fencing', () => {
    it('keeps an unreachable secondary Home on one presented phase across failing reachability retries', async () => {
        const h = await installHarness({ failingPing: true });
        const { storage } = await import('@/sync/domains/state/storage');
        const homeId = h.profiles.resolveServerProfileScopeIdForIdentifier(h.homeB.id);
        const published: string[] = [];
        const record = () => {
            const phase = storage.getState().concurrentSessionListCacheByServerId?.[homeId]?.listObservation?.phase;
            const machines = storage.getState().machineListStatusByServerId?.[homeId];
            const next = `${phase ?? '-'}/${machines ?? '-'}`;
            if (published[published.length - 1] !== next) published.push(next);
        };
        const unsubscribe = storage.subscribe(record);
        await vi.advanceTimersByTimeAsync(1_500);
        record();
        expect(published[published.length - 1]).toBe('offline/error');
        const settled = published.length;
        // Backoff grows from 1s toward 60s; two minutes covers many failing attempts.
        await vi.advanceTimersByTimeAsync(120_000);
        unsubscribe();
        expect(published.slice(settled)).toEqual([]);
    });

    it('forwards same-content secondary Home census activity without replacing its admitted Machine', async () => {
        vi.useRealTimers();
        const fixture = createMachineFixture({ id: 'secondary-activity', activeAt: Date.now() });
        let row = createPlainMachineRowFixture({ id: fixture.id, accountId: 'account-b', machine: fixture });
        const h = await installHarness({ realClock: true, machineRows: () => [row] });
        const { storage } = await import('@/sync/domains/state/storage');
        const { readMachineActivity } = await import('@/sync/domains/machines/machineActivity');
        const secondaryHomeId = h.profiles.resolveServerProfileScopeIdForIdentifier(h.homeB.id);
        storage.setState({ profile: { ...storage.getState().profile, id: 'account-a' },
            profileScope: { serverId: h.profiles.getActiveServerId(), accountId: 'account-a' } });
        h.pendingPings[0].respond();
        await vi.waitFor(() => expect(h.pool.peekServerReachabilityState(h.homeB.serverUrl, h.homeB.token)?.phase).toBe('online'));
        await h.refreshConcurrentOrdinarySessionList(secondaryHomeId);
        const retained = storage.getState().machineListByServerId[secondaryHomeId]?.find(machine => machine.id === fixture.id);
        expect(retained).toBeDefined();
        const activeMachines = storage.getState().machines;
        row = { ...row, activeAt: fixture.activeAt + 1 };
        await h.refreshConcurrentOrdinarySessionList(secondaryHomeId);
        expect(storage.getState().machineListByServerId[secondaryHomeId]?.find(machine => machine.id === fixture.id)).toBe(retained);
        expect(readMachineActivity(retained!).activeAt).toBe(row.activeAt);
        expect(retained?.activeAt).toBe(fixture.activeAt);
        expect(storage.getState().machines).toBe(activeMachines);
    });

    it('persists a secondary Home inventory only under its captured credential Account', async () => {
        vi.useRealTimers();
        const { prepareWarmCacheStorage, loadMachineDisplayWarmCacheEntries, setWarmCacheAccountScope } = await import('@/sync/domains/state/warmCachePersistence');
        await prepareWarmCacheStorage();
        setWarmCacheAccountScope('account-a');
        const h = await installHarness({ includeMachineInventory: true, realClock: true });
        const { storage } = await import('@/sync/domains/state/storage');
        const secondaryHomeId = h.profiles.resolveServerProfileScopeIdForIdentifier(h.homeB.id);
        storage.setState({ profile: { ...storage.getState().profile, id: 'account-a' },
            profileScope: { serverId: h.profiles.getActiveServerId(), accountId: 'account-a' } });
        h.pendingPings[0].respond();
        await vi.waitFor(() => expect(h.pool.peekServerReachabilityState(h.homeB.serverUrl, h.homeB.token)?.phase).toBe('online'));
        const refresh = h.refreshConcurrentOrdinarySessionList(secondaryHomeId);
        let settled = false;
        void refresh.then(() => { settled = true; }, () => { settled = true; });
        try {
            await vi.waitFor(() => expect(settled, JSON.stringify({
                paths: h.network.httpRequests.map(request => new URL(request.url).pathname),
                probes: h.pendingPings.length,
            })).toBe(true));
        } finally {
            // Retire every held external probe even when the refresh assertion fails.
            for (const ping of h.pendingPings) ping.respond();
            await refresh;
        }
        expect(storage.getState().machineListByServerId[secondaryHomeId], JSON.stringify({
            paths: h.network.httpRequests.map(request => new URL(request.url).pathname),
            status: storage.getState().machineListStatusByServerId[secondaryHomeId],
        })).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'machine-1' })]));
        await vi.waitFor(() => {
            expect(loadMachineDisplayWarmCacheEntries(secondaryHomeId, 'account-b')['machine-1'])
                .toMatchObject({ machineId: 'machine-1', host: 'tester.local' });
        });
        expect(loadMachineDisplayWarmCacheEntries(secondaryHomeId, 'account-a')['machine-1']).toBeUndefined();
    });

    it('retires a held authenticated probe after the cache stops without constructing a socket', async () => {
        const h = await installHarness();
        h.stopConcurrentSessionCacheSync();
        h.pendingPings[0].respond();
        await vi.advanceTimersByTimeAsync(1);

        expect(h.io).not.toHaveBeenCalled();
        expect(h.pool.peekServerReachabilityState(h.homeB.serverUrl, h.homeB.token)).toBeNull();
        expect(h.isConcurrentOrdinarySessionListHome(h.homeB.id)).toBe(false);
    });

    it('retires a held authenticated probe after its secondary Home is removed', async () => {
        const h = await installHarness();
        await h.profiles.removeServerProfile(h.homeB.id);
        await vi.advanceTimersByTimeAsync(1);
        h.pendingPings[0].respond();
        await vi.advanceTimersByTimeAsync(1);

        expect(h.io).not.toHaveBeenCalled();
        expect(h.pool.peekServerReachabilityState(h.homeB.serverUrl, h.homeB.token)).toBeNull();
        expect(h.isConcurrentOrdinarySessionListHome(h.homeB.id)).toBe(false);
    });

    it('retires the old credential probe and retains only the replacement Account runtime', async () => {
        const h = await installHarness();
        await h.network.setAccount(h.homeB.serverUrl, 'account-b-new');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const newToken = createAccountTokenForTests('account-b-new');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        expect(await TokenStorage.setCredentialsForServerUrl(h.homeB.serverUrl, { serverId: h.homeB.id }, { token: newToken })).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        await vi.waitFor(() => expect(h.pendingPings).toHaveLength(2));

        h.pendingPings[1].respond();
        await vi.advanceTimersByTimeAsync(1);
        h.pendingPings[0].respond();
        await vi.advanceTimersByTimeAsync(1);

        expect(h.pool.peekServerReachabilityState(h.homeB.serverUrl, h.homeB.token)).toBeNull();
        expect(h.pool.peekServerReachabilityState(h.homeB.serverUrl, newToken)?.phase).toBe('online');
        expect(h.io).toHaveBeenCalledTimes(1);
        expect(h.io).toHaveBeenCalledWith(h.homeB.serverUrl, expect.objectContaining({
            auth: expect.objectContaining({ token: newToken }),
        }));
        h.stopConcurrentSessionCacheSync();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.pool.peekServerReachabilityState(h.homeB.serverUrl, newToken)).toBeNull();
    });

    it('coalesces overlapping resumes and releases every cache lease without stopping another owner', async () => {
        const h = await installHarness();
        h.pool.setServerReachabilityNetworkAllowed(false);
        h.pool.setServerReachabilityNetworkAllowed(true);
        h.pool.setServerReachabilityNetworkAllowed(false);
        h.pool.setServerReachabilityNetworkAllowed(true);
        await vi.advanceTimersByTimeAsync(1);
        // The real pool shares the pending start for this exact Home/Account;
        // fabricated independently-resolvable owner leases are not network behavior.
        expect(h.pendingPings).toHaveLength(1);
        const observerPromise = h.pool.acquireServerReachabilitySupervisor({
            serverUrl: h.homeB.serverUrl, token: h.homeB.token,
        });
        h.pendingPings[0].respond();
        const observer = await observerPromise;
        await vi.advanceTimersByTimeAsync(1);
        expect(h.io).toHaveBeenCalledTimes(1);

        h.stopConcurrentSessionCacheSync();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.pool.peekServerReachabilityState(h.homeB.serverUrl, h.homeB.token)?.phase).toBe('online');
        await observer.release();
        expect(h.pool.peekServerReachabilityState(h.homeB.serverUrl, h.homeB.token)).toBeNull();
    });
});
