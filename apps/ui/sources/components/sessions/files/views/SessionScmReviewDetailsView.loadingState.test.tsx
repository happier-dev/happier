import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
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

installSessionFilesViewCommonModuleMocks({
    storage: async (importOriginal) =>
        createPartialStorageModuleMock(importOriginal, {
            useSession: (_id: string) => mockSession,
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionProjectScmSnapshot: () => null,
            useSessionProjectScmSnapshotError: () => null,
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
        invalidateFromAutoRefreshAndAwait: vi.fn(),
        invalidateFromMutationAndAwait: vi.fn(),
        invalidateFromUser: vi.fn(),
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

vi.mock('@/components/sessions/files/content/ChangedFilesReview', () => ({
    ChangedFilesReview: () => React.createElement('ChangedFilesReview'),
}));

describe('SessionScmReviewDetailsView (loading)', () => {
    it('shows a loading indicator while the SCM snapshot is not ready', async () => {
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionScmReviewDetailsView sessionId="s1" scopeId="session:s1" />)).tree;

        expect(tree!.findAllByType('ActivityIndicator')).toHaveLength(1);
    });
});
