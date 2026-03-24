import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createPartialStorageModuleMock, renderScreen } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSnapshot: any = null;

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
            useSessionProjectScmSnapshot: () => mockSnapshot,
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

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
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

describe('SessionScmReviewDetailsView (snapshot SWR)', () => {
    it('keeps last-known review content visible while snapshot is revalidating', async () => {
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');

        mockSnapshot = {
            fetchedAt: 1,
            projectKey: 'm1:/repo',
            repo: { isRepo: true, rootPath: '/tmp/repo', backendId: 'git', mode: '.git' },
            capabilities: { readLog: true },
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

        function Wrapper(props: Readonly<{ tick: number }>) {
            return React.createElement(SessionScmReviewDetailsView, { sessionId: 's1', scopeId: `session:s1:${props.tick}` });
        }

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(Wrapper, { tick: 0 }))).tree;

        expect(tree.findAllByType('ChangedFilesReview' as any)).toHaveLength(1);

        mockSnapshot = null;
        await act(async () => {
            tree.update(React.createElement(Wrapper, { tick: 1 }));
        });

        expect(tree.findAllByType('ChangedFilesReview' as any)).toHaveLength(1);
        expect(tree.findAllByType('ActivityIndicator')).toHaveLength(0);
    });
});
