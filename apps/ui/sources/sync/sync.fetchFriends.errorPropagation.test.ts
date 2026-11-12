import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// Install external transports before loading the real app runtime. Cold module
// compilation belongs to collection, not the per-test lifecycle hook.
const network = await installSessionOpsNetworkBoundary();
const syncBridge = await loadSyncSingletonForTests();

describe('sync fetchFriends error propagation', () => {
    let friendsStatus: number;
    let releaseFriends: (() => void) | undefined;

    beforeEach(async () => {
        friendsStatus = 200;
        const home = await network.addHome('https://friends-retry.example.test', 'account-friends');
        const { profileDefaults } = await import('./domains/profiles/profile');
        network.setHttpResponder(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({
                content: { t: 'plain', v: { experiments: true, featureToggles: { 'social.friends': true } } },
                version: 1,
            });
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: home.accountId });
            if (path === '/v2/sessions' || path === '/v2/sessions/active' || path === '/v2/sessions/query') return Response.json({
                sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
            });
            if (path === '/v1/machines') return Response.json([]);
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/kv') return Response.json({ items: [] });
            if (path === '/v1/features' || path === '/v1/features/authenticated') {
                return Response.json(createRootLayoutFeaturesResponse({ features: { social: { friends: { enabled: true } } } }));
            }
            if (path === '/v1/friends') return Response.json({ friends: [] }, { status: friendsStatus });
            return null;
        });
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        const { sync } = await import('./sync');
        releaseFriends = sync.acquirePeripheralFeed('friends');
        const { storage } = await import('./domains/state/storage');
        await vi.waitFor(() => expect(storage.getState().friendsLoaded).toBe(true));
        network.httpRequests.length = 0;
    });

    afterEach(async () => {
        releaseFriends?.();
        releaseFriends = undefined;
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        await network.dispose();
        syncBridge.dispose();
        vi.restoreAllMocks();
    });

    it('propagates errors so InvalidateSync can own retry/backoff semantics', async () => {
        const { sync } = await import('./sync');
        friendsStatus = 500;

        await expect((sync as unknown as { fetchFriends(): Promise<void> }).fetchFriends()).rejects.toThrow('500');
        const attempts = network.httpRequests.filter(({ url }) => new URL(url).pathname === '/v1/friends');
        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.token).toMatch(/^Bearer /);
    });
});
