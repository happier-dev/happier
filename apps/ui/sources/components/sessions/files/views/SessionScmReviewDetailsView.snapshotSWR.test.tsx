import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSnapshot: any = null;
let lastChangedFilesReviewProps: any = null;
let mockDerivedSessionChangeSet: any = {
    turnChangeSets: [],
    latestTurnChangeSet: null,
    latestTurnScopedChangeSet: null,
    sessionChangeSet: null,
    latestTurnDiffByPath: null,
    providerDiffByPath: null,
};

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (_: any) => 1 },
    View: (props: any) => React.createElement('View', props, props.children),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props, null),
    AppState: {
        currentState: 'active',
        addEventListener: () => ({ remove: () => {} }),
        removeEventListener: () => {},
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                divider: '#eee',
                textSecondary: '#666',
            },
        },
    }),
    StyleSheet: {
        create: (value: any) => value,
        absoluteFillObject: {},
    },
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
    useDerivedSessionChangeSet: () => mockDerivedSessionChangeSet,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () => ({ metadata: { path: '/tmp/repo' } }),
    useSessionMessages: () => ({ messages: [] }),
    useSessionProjectScmSnapshot: () => mockSnapshot,
    useSessionProjectScmSnapshotError: () => null,
    useSessionProjectScmTouchedPaths: () => [],
    useSessionProjectScmOperationLog: () => [],
    useProjectForSession: () => null,
    useProjectSessions: () => [],
    useSetting: () => 25,
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    useSession: () => ({ metadata: { path: '/tmp/repo' } }),
    useSessionMessages: () => ({ messages: [] }),
    useSessionProjectScmSnapshot: () => mockSnapshot,
    useSessionProjectScmSnapshotError: () => null,
    useSessionProjectScmTouchedPaths: () => [],
    useSessionProjectScmOperationLog: () => [],
    useProjectForSession: () => null,
    useProjectSessions: () => [],
    useSetting: () => 25,
    storage: {
        getState: () => ({}),
    },
    getStorage: () => ((selector: any) => selector({ localSettings: {} })),
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
    ChangedFilesReview: (props: any) => {
        lastChangedFilesReviewProps = props;
        return React.createElement('ChangedFilesReview', props);
    },
}));

describe('SessionScmReviewDetailsView (snapshot SWR)', () => {
    it('keeps last-known review content visible while snapshot is revalidating', async () => {
        lastChangedFilesReviewProps = null;
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
        await act(async () => {
            tree = renderer.create(React.createElement(Wrapper, { tick: 0 }));
        });

        expect(tree.root.findAllByType('ChangedFilesReview' as any)).toHaveLength(1);

        mockSnapshot = null;
        await act(async () => {
            tree.update(React.createElement(Wrapper, { tick: 1 }));
        });

        expect(tree.root.findAllByType('ChangedFilesReview' as any)).toHaveLength(1);
        expect(tree.root.findAllByType('ActivityIndicator')).toHaveLength(0);
    });

    it('prefers turn review mode and forwards turn diffs when a turn-scoped change set exists', async () => {
        lastChangedFilesReviewProps = null;
        mockDerivedSessionChangeSet = {
            turnChangeSets: [],
            latestTurnChangeSet: { id: 'turn-1' },
            latestTurnScopedChangeSet: { id: 'turn-1' },
            sessionChangeSet: null,
            latestTurnDiffByPath: new Map([['src/app.ts', 'turn-diff']]),
            providerDiffByPath: null,
        };
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
                includedFiles: 1,
                pendingFiles: 0,
                untrackedFiles: 0,
                includedAdded: 1,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionScmReviewDetailsView, { sessionId: 's1', scopeId: 'session:s1' }));
        });

        expect(tree.root.findAllByType('ChangedFilesReview' as any)).toHaveLength(1);
        expect(lastChangedFilesReviewProps?.changedFilesViewMode).toBe('turn');
        expect(lastChangedFilesReviewProps?.providerDiffByPath).toBeInstanceOf(Map);
        expect(lastChangedFilesReviewProps?.providerDiffByPath?.get('src/app.ts')).toBe('turn-diff');
    });
});
