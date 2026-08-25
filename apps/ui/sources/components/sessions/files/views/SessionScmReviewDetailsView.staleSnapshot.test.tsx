import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPartialStorageModuleMock, renderScreen } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

const mockSession = {
    id: 'session-1',
    seq: 0,
    createdAt: 0,
    updatedAt: 0,
    active: false,
    activeAt: 0,
    metadata: { path: '/tmp/repo', host: '' },
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    presence: 0,
} satisfies Session;

let mockSnapshot: any = null;
let mockSnapshotError: { message: string; at: number; errorCode?: string } | null = null;
const invalidateFromUserMock = vi.hoisted(() => vi.fn());

installSessionFilesViewCommonModuleMocks({
    storage: async (importOriginal) =>
        createPartialStorageModuleMock(importOriginal, {
            useSession: (_id: string) => mockSession,
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionProjectScmSnapshot: () => mockSnapshot,
            useSessionProjectScmSnapshotError: () => mockSnapshotError,
            useSessionRealtimeScmTranscriptConsumer: () => {},
            useSessionProjectScmTouchedPaths: () => [],
            useSessionProjectScmOperationLog: () => [],
            useProjectForSession: () => null,
            useProjectSessions: () => [],
            useSetting: () => 25,
        }),
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        openDetailsTab: vi.fn(),
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/session/files/useChangedFilesData', () => ({
    useChangedFilesData: () => ({
        attributionReliability: 'high',
        allRepositoryChangedFiles: [],
        turnAttributedFiles: [],
        turnRepositoryOnlyFiles: [],
        sessionAttributedFiles: [],
        repositoryOnlyFiles: [],
        suppressedInferredCount: 0,
        showTurnViewToggle: false,
        showSessionViewToggle: false,
    }),
}));

vi.mock('@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet', () => ({
    useDerivedSessionChangeSet: () => ({
        turnChangeSets: [],
        latestTurnChangeSet: null,
        latestTurnScopedChangeSet: null,
        sessionChangeSet: null,
        latestTurnDiffByPath: null,
        providerDiffByPath: null,
    }),
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromAutoRefresh: vi.fn(),
        invalidateFromAutoRefreshAndAwait: vi.fn(async () => {}),
        invalidateFromMutationAndAwait: vi.fn(async () => {}),
        invalidateFromUser: invalidateFromUserMock,
    },
}));

vi.mock('@/scm/diffCache/useScmDiffCacheLimits', () => ({
    useScmDiffCacheLimits: () => {},
}));

vi.mock('@/scm/refresh/useScmAdaptivePolling', () => ({
    useScmAdaptivePolling: () => {},
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        visibility: { top: false, bottom: false, left: false, right: false },
        onViewportLayout: () => {},
        onContentSizeChange: () => {},
        onScroll: () => {},
    }),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: () => null,
}));
vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => null,
}));

vi.mock('@/components/workspaces/scm/review/ChangedFilesReview', () => ({
    ChangedFilesReview: () => React.createElement('ChangedFilesReview', { testID: 'scm-review-list' }),
}));

function createSnapshot(isRepo: boolean) {
    return {
        fetchedAt: 1,
        projectKey: 'm1:/tmp/repo',
        repo: isRepo
            ? { isRepo: true, rootPath: '/tmp/repo', backendId: 'git', mode: '.git' }
            : { isRepo: false, rootPath: null, backendId: null, mode: null },
        capabilities: {
            readStatus: true,
            readLog: true,
            writeCommit: true,
            supportedDiffAreas: ['included', 'pending'],
        },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    };
}

async function render() {
    const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
    return renderScreen(<SessionScmReviewDetailsView sessionId="s1" scopeId="session:s1" />);
}

// Assertions about the notice use `findHostByTestId`: a component that takes a `testID` and then
// renders `null` still matches `findByTestId` by props, so the absence case would pass for the
// wrong reason. Host lookups are the same query restricted to the nodes that actually painted.
/**
 * `F-SCM-3`: the review surface reported a snapshot error ONLY at
 * `if (!effectiveSnapshot && snapshotError)`, and `scmStatusSync`'s catch stores the error WITHOUT
 * clearing the snapshot. So once any read had succeeded, every later refresh failure was invisible
 * and the cached review — including a cached "not under source control" — read as current.
 */
describe('SessionScmReviewDetailsView (stale snapshot)', () => {
    beforeEach(() => {
        invalidateFromUserMock.mockClear();
    });

    it('surfaces a failing refresh while keeping the cached review visible', async () => {
        mockSnapshot = createSnapshot(true);
        mockSnapshotError = { message: 'RPC method not available', at: 1, errorCode: 'BACKEND_UNAVAILABLE' };

        const screen = await render();

        expect(screen.findHostByTestId('session-scm-review-stale')).not.toBeNull();
        expect(screen.findHostByTestId('session-scm-review-stale-diagnostic-BACKEND_UNAVAILABLE')).not.toBeNull();
        expect(screen.findByTestId('scm-review-list')).not.toBeNull();
        expect(screen.findHostByTestId('source-control-unavailable')).toBeNull();

        await screen.pressByTestIdAsync('session-scm-review-stale-action');
        expect(invalidateFromUserMock).toHaveBeenCalledWith('s1');
    });

    it('surfaces a failing refresh over a cached "not a repository" answer', async () => {
        mockSnapshot = createSnapshot(false);
        mockSnapshotError = { message: 'RPC method not available', at: 1, errorCode: 'BACKEND_UNAVAILABLE' };

        const screen = await render();

        expect(screen.findHostByTestId('session-scm-review-stale')).not.toBeNull();
        expect(screen.getTextContent()).toContain('files.notUnderSourceControl');
    });

    it('stays quiet when the snapshot is current', async () => {
        mockSnapshot = createSnapshot(true);
        mockSnapshotError = null;

        const screen = await render();

        expect(screen.findHostByTestId('session-scm-review-stale')).toBeNull();
        expect(screen.findByTestId('scm-review-list')).not.toBeNull();
    });
});
