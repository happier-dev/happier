import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPartialStorageModuleMock, renderScreen } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSnapshot: any = null;
let reviewCommentsFeatureEnabled = false;
let scmWriteOperationsFeatureEnabled = false;
const changedFilesReviewSpy = vi.fn();

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
            useWorkspaceReviewCommentsDrafts: () => [{ id: 'draft-1' }],
        }),
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

const mockPaneScope = {
    openDetailsTab: vi.fn(),
    setDetailsTabState: vi.fn(),
    scopeState: null,
};

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => mockPaneScope,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => {
        if (featureId === 'files.reviewComments') return reviewCommentsFeatureEnabled;
        if (featureId === 'scm.writeOperations') return scmWriteOperationsFeatureEnabled;
        return false;
    },
}));

vi.mock('@/sync/domains/session/resolveWorkspaceScopeForSession', () => ({
    useWorkspaceScopeForSession: (sessionId?: string | null) => (
        sessionId === 's1'
            ? { serverId: 'server-1', machineId: 'machine-1', rootPath: '/tmp/repo' }
            : null
    ),
}));

const reviewDraftHandlers = {
    onUpsertReviewCommentDraft: vi.fn(),
    onDeleteReviewCommentDraft: vi.fn(),
    onReviewCommentError: vi.fn(),
};

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers', () => ({
    useWorkspaceReviewCommentDraftHandlers: () => reviewDraftHandlers,
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

vi.mock('@/components/workspaces/scm/review/ChangedFilesReview', () => ({
    ChangedFilesReview: (props: any) => {
        changedFilesReviewSpy(props);
        return React.createElement('ChangedFilesReview', props);
    },
}));

describe('SessionScmReviewDetailsView (snapshot SWR)', () => {
    beforeEach(() => {
        reviewCommentsFeatureEnabled = false;
        scmWriteOperationsFeatureEnabled = false;
        changedFilesReviewSpy.mockClear();
        mockPaneScope.openDetailsTab.mockClear();
        mockPaneScope.setDetailsTabState.mockClear();
        reviewDraftHandlers.onUpsertReviewCommentDraft.mockClear();
        reviewDraftHandlers.onDeleteReviewCommentDraft.mockClear();
        reviewDraftHandlers.onReviewCommentError.mockClear();
    });

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

    it('enables review comments for SCM review diffs when the session has a workspace scope', async () => {
        reviewCommentsFeatureEnabled = true;
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

        await renderScreen(React.createElement(SessionScmReviewDetailsView, { sessionId: 's1', scopeId: 'session:s1:0' }));

        expect(changedFilesReviewSpy).toHaveBeenCalledWith(expect.objectContaining({
            reviewCommentsEnabled: true,
            reviewCommentDrafts: [{ id: 'draft-1' }],
            onUpsertReviewCommentDraft: reviewDraftHandlers.onUpsertReviewCommentDraft,
            onDeleteReviewCommentDraft: reviewDraftHandlers.onDeleteReviewCommentDraft,
            onReviewCommentError: reviewDraftHandlers.onReviewCommentError,
        }));
    });

    it('keeps review callbacks stable across unrelated parent rerenders', async () => {
        scmWriteOperationsFeatureEnabled = true;
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
            return React.createElement(
                React.Fragment,
                null,
                React.createElement('TickMarker', { value: props.tick }),
                React.createElement(SessionScmReviewDetailsView, { sessionId: 's1', scopeId: `session:s1:${props.tick}` }),
            );
        }

        const { tree } = await renderScreen(React.createElement(Wrapper, { tick: 0 }));
        const firstProps = changedFilesReviewSpy.mock.calls.at(-1)?.[0];
        const firstCallCount = changedFilesReviewSpy.mock.calls.length;

        await act(async () => {
            tree.update(React.createElement(Wrapper, { tick: 1 }));
        });

        const nextProps = changedFilesReviewSpy.mock.calls.at(-1)?.[0];
        expect(changedFilesReviewSpy.mock.calls.length).toBeGreaterThan(firstCallCount);
        expect(nextProps.onFilePress).toBe(firstProps.onFilePress);
        expect(nextProps.onFilePressPinned).toBe(firstProps.onFilePressPinned);
        expect(nextProps.renderFileTrailingActions).toBe(firstProps.renderFileTrailingActions);
    });
});
