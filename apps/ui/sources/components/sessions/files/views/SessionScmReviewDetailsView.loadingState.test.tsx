import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (_: any) => 1 },
    View: (props: any) => React.createElement('View', props, props.children),
    Text: (props: any) => React.createElement('Text', props, props.children),
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

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () => ({ metadata: { path: '/tmp/repo' } }),
    useSessionMessages: () => ({ messages: [] }),
    useSessionProjectScmSnapshot: () => null,
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
    useSessionProjectScmSnapshot: () => null,
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
    ChangedFilesReview: () => React.createElement('ChangedFilesReview'),
}));

describe('SessionScmReviewDetailsView (loading)', () => {
    it('shows a loading indicator while the SCM snapshot is not ready', async () => {
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionScmReviewDetailsView sessionId="s1" scopeId="session:s1" />);
        });

        expect(tree!.root.findAllByType('ActivityIndicator')).toHaveLength(1);
    });
});
