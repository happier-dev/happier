import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ABSENT_SESSION_FOLLOW_FACTS_V1,
    NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1,
    SessionOrganizationSnapshotSchema,
    SessionViewerProjectionV1Schema,
    projectViewerReadStateV1,
    resolveSessionEffectiveNotificationV1,
    resolveSessionPersonalAttentionV1,
    resolveSessionPersonalRelevanceV1,
} from '@happier-dev/protocol';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const route = vi.hoisted(() => ({ pathname: '/session/done' }));
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return { ...createExpoRouterMock().module, usePathname: () => route.pathname };
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
// This third-party renderer is not exercised by a session-list state hook.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

function currentViewer(seq: number, cursor: number, latestReadyEventSeq: number | null = null) {
    const readState = projectViewerReadStateV1({
        tracked: true,
        row: { lastViewedSessionSeq: cursor, unreadSince: cursor < seq ? 300 : null },
        visibleSessionSeq: seq,
    });
    return SessionViewerProjectionV1Schema.parse({
        readState,
        relevance: resolveSessionPersonalRelevanceV1({ ...NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1, ownedByMe: true }),
        attention: resolveSessionPersonalAttentionV1({
            tracked: true, accessible: true, accountSuspended: false, contentAvailable: true,
            visibleSessionSeq: seq, readState, latestReadyEventSeq, hasPrimarySessionFailure: false,
            pendingBlockedCount: 0, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
            capabilities: { canSubmitAgentInput: true, canApprovePermissions: true },
            responsible: false, discussion: { hasUnread: false, hasMention: false },
            attentionStanding: 'none', reminderDue: false,
        }),
        follow: ABSENT_SESSION_FOLLOW_FACTS_V1,
        notification: resolveSessionEffectiveNotificationV1({ facts: ABSENT_SESSION_FOLLOW_FACTS_V1, isSessionOwner: true }),
    });
}

function completedSession(cursor: number, serverId: string) {
    return createSessionFixture({
        id: 'done', serverId, owner: 'u1', seq: 3, lastViewedSessionSeq: cursor,
        viewer: currentViewer(3, cursor, 3), latestTurnStatus: 'completed',
        latestReadyEventSeq: 3, latestReadyEventAt: 300,
        lastTurnCompletedAt: 300, updatedAt: 300, active: false, presence: 0,
    });
}

describe('visible session-list retained attention through real state', () => {
    let previousState: ReturnType<(typeof import('@/sync/domains/state/storage'))['storage']['getState']>;
    let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
    let serverId: string;

    beforeEach(async () => {
        await home.reset();
        const { storage } = await import('@/sync/domains/state/storage');
        previousState = storage.getState();
        await loadSyncSingletonForTests();
        serverId = await home.addHome({ name: 'Retained attention Home', serverUrl: 'https://retained-attention.test', accountId: 'u1' });
        const http = createHomeHubArtifactHttpBoundary('u1');
        account = await restoreServerAccountForTest({ serverUrl: 'https://retained-attention.test', accountId: 'u1', request: http.request });
        expect(account.home.id).toBe(serverId);
        await storage.getState().activateSettingsScope({ serverId, accountId: 'u1' });
        storage.getState().applySettingsLocal({
            sessionListOrderingModeV1: 'custom', sessionListAttentionPromotionModeV1: 'global',
            sessionListAttentionStandingDefaultV1: false, sessionListWorkingPlacementModeV1: 'off',
            sessionListSectionModeV1: 'single', sessionListActiveGroupingV1: 'date',
            sessionListInactiveGroupingV1: 'date', hideInactiveSessions: false, sessionFolderViewModeV1: 'off',
        });
        storage.getState().applySessionOrganizationSnapshot(serverId, SessionOrganizationSnapshotSchema.parse({
            schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], tags: [],
            tagAssignments: [], orderEntries: [], labels: [],
        }));
        storage.getState().applySessions([
            completedSession(2, serverId),
            createSessionFixture({ id: 'quiet', serverId, owner: 'u1', seq: 1, lastViewedSessionSeq: 1, viewer: currentViewer(1, 1), updatedAt: 100, active: false, presence: 0 }),
        ]);
        // Hydration is deliberately row-only. Ordinary admission belongs to the
        // server page producer, not to whichever Session was opened or updated.
        storage.getState().applyServerScopedSessionListRows(serverId, Object.values(storage.getState().sessionListRowsByServerId[serverId] ?? {}), {
            source: 'ordinary', mode: 'replace',
        });
        route.pathname = '/session/done';
        vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 1, 17));
    });

    afterEach(async () => {
        await standardCleanup();
        await account?.dispose();
        account = undefined;
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState(previousState, true);
        await home.reset();
    });

    it('uses a retained foreground pathname when retaining selected attention after remount', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        expect(storage.getState().ordinarySessionListMembershipByServerId[serverId]).toEqual(['done', 'quiet']);
        expect(storage.getState().sessionListIndexByServerId[serverId]?.filter((item) => item.type === 'session')
            .map((item) => item.sessionId)).toEqual(['done', 'quiet']);
        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const expectedIndex = [
            expect.objectContaining({ type: 'header', headerKind: 'attention' }),
            expect.objectContaining({ type: 'session', sessionId: 'done', groupKind: 'attention' }),
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'quiet', groupKind: 'date' }),
        ];
        const firstHook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();
        const retainedVisibleSessionListIndex = firstHook.getCurrent()?.visibleSessionListIndex;
        expect(retainedVisibleSessionListIndex).toEqual(expectedIndex);
        await firstHook.unmount();

        storage.getState().applySessions([completedSession(3, serverId)]);
        route.pathname = '/';
        const remountOptions = { pathname: '/', retainedPathname: '/session/done', retainedVisibleSessionListIndex };
        const remountedHook = await renderHook(() => useVisibleSessionListViewState('all', remountOptions));
        await flushHookEffects();
        expect(remountedHook.getCurrent()?.visibleSessionListIndex).toEqual(expectedIndex);
        await remountedHook.rerender();
        expect(remountedHook.getCurrent()?.visibleSessionListIndex).toEqual(expectedIndex);
    });
});
