import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
import type { ActivityLocalNotificationEvent } from '@/activity/notifications/runtime/activityLocalNotificationBus';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';

type SyncReadyNotificationTestAccess = Readonly<{
    notifyReadyProjectionAdvance: (sessionId: string, seq: number, serverId: string | null) => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => unknown;
}>;

function readyMessage(seq: number): NormalizedMessage {
    return {
        id: `ready-${seq}`, seq, localId: null, createdAt: 1_000 + seq,
        isSidechain: false, role: 'event', content: { type: 'ready' },
    };
}

describe('Sync ready notification dedupe', () => {
    let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>;
    let homeA: Awaited<ReturnType<typeof network.addHome>>;
    let homeB: Awaited<ReturnType<typeof network.addHome>>;
    let unsubscribe: () => void;
    let events: ActivityLocalNotificationEvent[];
    let voiceOnReady: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        vi.resetModules();
        network = await installSessionOpsNetworkBoundary();
        homeA = await network.addHome('https://ready-a.example.test', 'account-a');
        homeB = await network.addHome('https://ready-b.example.test', 'account-b');
        const { profileDefaults } = await import('./domains/profiles/profile');
        network.setHttpResponder(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: homeA.accountId });
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
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
        await upsertAndActivateServer({ serverUrl: homeA.serverUrl });
        await restoreConnectionToActiveServer({ token: homeA.token });
        const { storage } = await import('./domains/state/storage');
        await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
        const { voiceHooks } = await import('@/voice/context/voiceHooks');
        // Observe the real voice owner without replacing its policy or sink.
        voiceOnReady = vi.spyOn(voiceHooks, 'onReady');
        const { subscribeActivityLocalNotifications } = await import('@/activity/notifications/runtime/activityLocalNotificationBus');
        events = [];
        unsubscribe = subscribeActivityLocalNotifications((event) => events.push(event));
    });

    afterEach(async () => {
        unsubscribe();
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        network.dispose();
        vi.restoreAllMocks();
    });

    it('dedupes projection ready notifications against later transcript catch-up for the same ready seq', async () => {
        const { sync } = await import('./sync');
        const { storage } = await import('./domains/state/storage');
        const syncForTest = sync as unknown as SyncReadyNotificationTestAccess;
        storage.getState().applySessions([createSessionFixture({ id: 's1', serverId: homeA.id, seq: 0, active: true })]);

        syncForTest.notifyReadyProjectionAdvance('s1', 2, homeA.id);
        syncForTest.applyMessages('s1', [readyMessage(2)]);
        syncForTest.applyMessages('s1', [readyMessage(3)]);

        expect(voiceOnReady).toHaveBeenCalledTimes(2);
        expect(voiceOnReady).toHaveBeenNthCalledWith(1, { serverId: homeA.id, sessionId: 's1' }, []);
        expect(voiceOnReady).toHaveBeenNthCalledWith(2, { serverId: homeA.id, sessionId: 's1' }, []);
        expect(events).toEqual([2, 3].map((sequence) => ({
            kind: 'ready', event: 'ready',
            address: { serverId: homeA.id, sessionId: 's1' }, messages: [],
            committedSequence: { sequenceDomain: 'session_transcript', sequence },
        })));
    });

    it('keeps equal Session ids on different Homes in separate ready frontiers', async () => {
        const { sync } = await import('./sync');
        const syncForTest = sync as unknown as SyncReadyNotificationTestAccess;

        syncForTest.notifyReadyProjectionAdvance('same-session', 2, homeA.id);
        syncForTest.notifyReadyProjectionAdvance('same-session', 2, homeB.id);

        expect(voiceOnReady).toHaveBeenCalledTimes(2);
        expect(voiceOnReady).toHaveBeenNthCalledWith(1, { serverId: homeA.id, sessionId: 'same-session' }, []);
        expect(voiceOnReady).toHaveBeenNthCalledWith(2, { serverId: homeB.id, sessionId: 'same-session' }, []);
        expect(events).toEqual([homeA.id, homeB.id].map((serverId) => ({
            kind: 'ready', event: 'ready',
            address: { serverId, sessionId: 'same-session' }, messages: [],
            committedSequence: { sequenceDomain: 'session_transcript', sequence: 2 },
        })));
    });
});
