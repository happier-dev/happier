import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

let cleanup: (() => Promise<void>) | null = null;

async function installHarness() {
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
        if (path === '/v2/sessions') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        if (path === '/v1/machines') return Response.json([]);
        return null;
    });
    const pool = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    pool.setServerReachabilityNetworkAllowed(true);
    const cache = await import('./concurrentSessionCache');
    cleanup = async () => {
        cache.stopConcurrentSessionCacheSync();
        for (const ping of pendingPings) ping.respond();
        await vi.advanceTimersByTimeAsync(1);
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
    };
    cache.startConcurrentSessionCacheSync();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(pendingPings).toHaveLength(1));
    return { ...cache, network, homeB, profiles, pool, pendingPings, io };
}

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
});
afterEach(async () => {
    await cleanup?.();
    cleanup = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
});

describe('concurrent session cache reachability lease fencing', () => {
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
