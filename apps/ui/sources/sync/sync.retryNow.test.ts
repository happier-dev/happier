import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const network = await installSessionOpsNetworkBoundary();
const syncBridge = await loadSyncSingletonForTests();
afterAll(async () => {
    try { await network.dispose(); }
    finally { syncBridge.dispose(); }
});

describe('sync manual retry', () => {
    let home: Awaited<ReturnType<typeof network.addHome>>;

    beforeEach(async () => {
        network.resetRequests();
        home = await network.addHome('https://manual-retry.example.test', 'account-retry');
        const { profileDefaults } = await import('./domains/profiles/profile');
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: home.accountId });
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v2/sessions' || path === '/v2/sessions/active' || path === '/v2/sessions/query') return Response.json({
                sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
            });
            if (path === '/v1/machines') return Response.json([]);
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends') return Response.json({ friends: [] });
            if (path === '/v1/kv') return Response.json({ items: [] });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        });
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        const { storage } = await import('./domains/state/storage');
        await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
        network.httpRequests.length = 0;
    });

    afterEach(async () => {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        vi.restoreAllMocks();
    });

    async function expectManualRecovery() {
        const { sync } = await import('./sync');
        const { storage } = await import('./domains/state/storage');
        storage.getState().setSyncError({
            kind: 'unknown', message: 'Previous background read failed', retryable: true,
            at: Date.now(), serverId: home.id,
        });
        // Call-through observation retains the real resume owner and its HTTP work.
        const resume = vi.spyOn(sync, 'resumeSync');
        sync.retryNow();
        // The previous failure is withdrawn before asynchronous recovery can succeed.
        expect(storage.getState().syncError).toBeNull();
        expect(resume).toHaveBeenCalledWith('manual');
        await resume.mock.results.find((result) => result.type === 'return')?.value;
        await vi.waitFor(() => {
            const paths = network.httpRequests.map(({ url }) => new URL(url).pathname);
            expect(paths).toContain('/v1/auth/ping');
            expect(paths).toContain('/v2/changes');
        });
        const changes = network.httpRequests.filter(({ url }) => new URL(url).pathname === '/v2/changes');
        expect(changes.every(({ token, url }) => token === `Bearer ${home.token}` && new URL(url).origin === home.serverUrl)).toBe(true);
    }

    it('manual retry refreshes reachability and resumes HTTP sync', async () => {
        const socket = network.socketBoundaries.find((boundary) => boundary.serverUrl === home.serverUrl)?.socket;
        expect(socket).toBeDefined();
        const connectsBefore = network.socketBoundaries.reduce((count, boundary) => count + boundary.socket.connect.mock.calls.length, 0);
        const disconnectsBefore = socket!.disconnect.mock.calls.length;

        await expectManualRecovery();

        expect(socket!.disconnect.mock.calls.length).toBeGreaterThan(disconnectsBefore);
        expect(network.socketBoundaries.reduce((count, boundary) => count + boundary.socket.connect.mock.calls.length, 0)).toBeGreaterThan(connectsBefore);
    });

    it('manual retry still refreshes reachability and HTTP sync when the network socket reconnect fails', async () => {
        const connectFailure = vi.fn(() => { throw new Error('connect failed'); });
        network.setSocketConfigurator(({ socket }) => {
            socket.connect.mockImplementationOnce(connectFailure);
        });

        await expectManualRecovery();
        expect(connectFailure).toHaveBeenCalled();
    });
});
