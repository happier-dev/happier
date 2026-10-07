import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PauseController } from '@/utils/timing/pauseController';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('sync resumeSync background interruption', () => {
    let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>;
    let home: Awaited<ReturnType<typeof network.addHome>>;
    let changesStarted: Promise<void>;
    let releaseChanges: () => void;
    let startChanges: () => void;
    let changesResponse: Promise<void>;
    let holdChanges: boolean;
    let nextCursor: number;
    let now: number;

    beforeEach(async () => {
        vi.resetModules();
        holdChanges = false;
        nextCursor = 0;
        now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        changesStarted = new Promise((resolve) => { startChanges = resolve; });
        changesResponse = new Promise((resolve) => { releaseChanges = resolve; });
        network = await installSessionOpsNetworkBoundary();
        home = await network.addHome('https://resume-a.example.test', 'account-resume');
        const { profileDefaults } = await import('./domains/profiles/profile');
        network.setHttpResponder(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: home.accountId });
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v2/cursor') return Response.json({ cursor: 0 });
            if (path === '/v2/changes') {
                if (holdChanges) { startChanges(); await changesResponse; }
                return Response.json({ changes: [], nextCursor });
            }
            if (path === '/v2/sessions') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (path === '/v1/machines') return Response.json([]);
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends') return Response.json({ friends: [] });
            if (path === '/v1/kv') return Response.json({ items: [] });
            return null;
        });
        await loadSyncSingletonForTests();
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        const { storage } = await import('./domains/state/storage');
        await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
        // The elapsed downtime comes from a real transport disconnect and clock,
        // not synthetic private Sync credentials/encryption or disconnected state.
        const socket = network.socketBoundaries.find((boundary) => boundary.serverUrl === home.serverUrl);
        expect(socket).toBeDefined();
        socket!.trigger('disconnect', 'transport close');
        now += 1_000;
        network.httpRequests.length = 0;
        holdChanges = true;
    });

    afterEach(async () => {
        releaseChanges();
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        network.dispose();
        vi.restoreAllMocks();
    });

    it('does not continue issuing HTTP sync requests after app is backgrounded mid-resume', async () => {
        const { sync } = await import('./sync');
        const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
        expect(pauseController.isPaused()).toBe(false);
        const resumed = sync.resumeSync('socket-reconnect');
        await changesStarted;

        pauseController.pause();
        releaseChanges();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(network.httpRequests.filter(({ url }) => new URL(url).pathname === '/v2/sessions')).toEqual([]);

        pauseController.resume();
        await resumed;
        expect(network.httpRequests.map(({ url }) => new URL(url).pathname)).toContain('/v2/sessions');
    }, 60_000);

    it('does not checkpoint an in-flight changes cursor after the server scope is reset', async () => {
        const { sync } = await import('./sync');
        const { loadChangesCursor } = await import('./domains/state/persistence');
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        nextCursor = 99;
        const resumed = sync.resumeSync('socket-reconnect');
        await changesStarted;

        await sync.disconnectServer();
        const other = await network.addHome('https://resume-b.example.test', 'account-other');
        await upsertAndActivateServer({ serverUrl: other.serverUrl });
        releaseChanges();
        await resumed;

        expect(loadChangesCursor({ serverScope: other.id, accountId: other.accountId })).toBeNull();
        expect(loadChangesCursor({ serverScope: home.id, accountId: home.accountId })).not.toBe('99');
    }, 60_000);
});
