import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPartialStorageModuleMock, renderScreen } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSnapshot: any = null;
let reviewCommentsFeatureEnabled = false;
let scmWriteOperationsFeatureEnabled = false;
let mockScmCommitStrategy: 'atomic' | 'git_staging' = 'atomic';
const changedFilesReviewSpy = vi.fn();
const invalidateFromAutoRefreshSpy = vi.hoisted(() => vi.fn());
const invalidateFromAutoRefreshAndAwaitSpy = vi.hoisted(() => vi.fn());
const invalidateFromMutationAndAwaitSpy = vi.hoisted(() => vi.fn());
const invalidateFromUserSpy = vi.hoisted(() => vi.fn());

const mockSession = {
    id: 'session-1',
    seq: 0,
    createdAt: 0,
    updatedAt: 0,
    active: false,
    activeAt: 0,
    metadata: { path: '/tmp/repo', host: '', machineId: 'machine-1' },
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
            useSessionWorkspacePath: () => '/tmp/repo',
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionProjectScmSnapshot: () => mockSnapshot,
            useSessionProjectScmSnapshotError: () => null,
            useSessionRealtimeScmTranscriptConsumer: () => {},
            useSessionProjectScmTouchedPaths: () => [],
            useSessionProjectScmOperationLog: () => [],
            useSessionProjectScmCommitSelectionPaths: () => [],
            useSessionProjectScmCommitSelectionPatches: () => [],
            useProjectForSession: () => null,
            useProjectSessions: () => [],
            useWorkspaceReviewCommentsDrafts: () => [],
            useSetting: (key: string) => key === 'scmCommitStrategy' ? mockScmCommitStrategy : 25,
            upsertWorkspaceReviewCommentDraft: () => {},
            deleteWorkspaceReviewCommentDraft: () => {},
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
    scopeState: null as null | { details: { tabState: Record<string, unknown> } },
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
    useWorkspaceScopeForSession: (sessionId: string | null | undefined) => (
        sessionId === 's1'
            ? { serverId: 'server-1', machineId: 'machine-1', rootPath: '/tmp/repo' }
            : null
    ),
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
        invalidateFromAutoRefresh: invalidateFromAutoRefreshSpy,
        invalidateFromAutoRefreshAndAwait: invalidateFromAutoRefreshAndAwaitSpy,
        invalidateFromMutationAndAwait: invalidateFromMutationAndAwaitSpy,
        invalidateFromUser: invalidateFromUserSpy,
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
        changedFilesReviewSpy(props);
        return React.createElement('ChangedFilesReview', props);
    },
}));

describe('SessionScmReviewDetailsView (snapshot SWR)', () => {
    beforeEach(() => {
        reviewCommentsFeatureEnabled = false;
        scmWriteOperationsFeatureEnabled = false;
        mockScmCommitStrategy = 'atomic';
        changedFilesReviewSpy.mockClear();
        mockPaneScope.openDetailsTab.mockClear();
        mockPaneScope.setDetailsTabState.mockClear();
        mockPaneScope.scopeState = null;
        invalidateFromAutoRefreshSpy.mockClear();
        invalidateFromAutoRefreshAndAwaitSpy.mockClear();
        invalidateFromMutationAndAwaitSpy.mockClear();
        invalidateFromUserSpy.mockClear();
        mockSnapshot = null;
    });

    afterEach(() => {
        vi.useRealTimers();
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

    it('uses the auto-refresh lease for the initial review snapshot warm-up', async () => {
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');

        await renderScreen(<SessionScmReviewDetailsView sessionId="s1" scopeId="session:s1" />);

        expect(invalidateFromAutoRefreshSpy).toHaveBeenCalledTimes(1);
        expect(invalidateFromAutoRefreshSpy).toHaveBeenCalledWith('s1');
        expect(invalidateFromUserSpy).not.toHaveBeenCalled();
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

        await renderScreen(<SessionScmReviewDetailsView sessionId="s1" scopeId="session:s1" />);

        expect(changedFilesReviewSpy).toHaveBeenCalledWith(expect.objectContaining({
            reviewCommentsEnabled: true,
            reviewCommentDrafts: expect.any(Array),
            onUpsertReviewCommentDraft: expect.any(Function),
            onDeleteReviewCommentDraft: expect.any(Function),
            onReviewCommentError: expect.any(Function),
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

    it('offers the canonical per-file staging action directly in the review list', async () => {
        scmWriteOperationsFeatureEnabled = true;
        mockScmCommitStrategy = 'git_staging';
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
        const { ScmCommitSelectionToggleButton } = await import('@/components/sessions/sourceControl/commitSelection/ScmCommitSelectionToggleButton');

        mockSnapshot = {
            fetchedAt: 1,
            projectKey: 'm1:/repo',
            repo: { isRepo: true, rootPath: '/tmp/repo', backendId: 'git', mode: '.git' },
            capabilities: { readLog: true, writeCommit: true, writeInclude: true, writeExclude: true },
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
        const file = {
            fullPath: 'src/staged.ts',
            fileName: 'staged.ts',
            isIncluded: true,
        } as any;

        await renderScreen(<SessionScmReviewDetailsView sessionId="s1" scopeId="session:s1" />);

        const reviewProps = changedFilesReviewSpy.mock.calls.at(-1)?.[0];
        expect(typeof reviewProps.renderFileActions).toBe('function');
        const action = reviewProps.renderFileActions(file);
        expect(action.type).toBe(ScmCommitSelectionToggleButton);
        expect(action.props).toEqual(expect.objectContaining({
            sessionId: 's1',
            sessionPath: '/tmp/repo',
            snapshot: mockSnapshot,
            scmWriteEnabled: true,
            commitStrategy: 'git_staging',
            file,
            selectedForCommit: true,
            surface: 'files',
        }));
    });

    it('debounces review scroll position persistence during scrolling', async () => {
        vi.useFakeTimers();
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

        await renderScreen(<SessionScmReviewDetailsView sessionId="s1" scopeId="session:s1" />);
        const reviewProps = changedFilesReviewSpy.mock.calls.at(-1)?.[0];
        expect(typeof reviewProps.onScrollTopChange).toBe('function');

        act(() => {
            reviewProps.onScrollTopChange(120);
        });

        expect(mockPaneScope.setDetailsTabState).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(200);
        });
        expect(mockPaneScope.setDetailsTabState).not.toHaveBeenCalled();

        act(() => {
            reviewProps.onScrollTopChange(240);
            reviewProps.onScrollTopChange(360);
        });

        await act(async () => {
            vi.advanceTimersByTime(249);
        });
        expect(mockPaneScope.setDetailsTabState).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(1);
        });

        expect(mockPaneScope.setDetailsTabState).toHaveBeenCalledTimes(1);
        expect(mockPaneScope.setDetailsTabState).toHaveBeenCalledWith('scmReview:working', {
            scrollTop: 360,
        });
    });

    it('does not feed persisted scroll updates back into the mounted review initial scroll position', async () => {
        vi.useFakeTimers();
        mockPaneScope.scopeState = {
            details: {
                tabState: {
                    'scmReview:working': {
                        scrollTop: 120,
                    },
                },
            },
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
                includedFiles: 0,
                pendingFiles: 0,
                untrackedFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        };

        const { tree } = await renderScreen(<SessionScmReviewDetailsView sessionId="s1" scopeId="session:s1" />);
        const firstProps = changedFilesReviewSpy.mock.calls.at(-1)?.[0];
        expect(firstProps.initialScrollTop).toBe(120);

        act(() => {
            firstProps.onScrollTopChange(360);
        });
        await act(async () => {
            vi.advanceTimersByTime(250);
        });

        expect(mockPaneScope.setDetailsTabState).toHaveBeenCalledWith('scmReview:working', {
            scrollTop: 360,
        });

        mockPaneScope.scopeState = {
            details: {
                tabState: {
                    'scmReview:working': {
                        scrollTop: 360,
                    },
                },
            },
        };

        await act(async () => {
            tree.update(<SessionScmReviewDetailsView sessionId="s1" scopeId="session:s1:rerender" />);
        });

        const nextProps = changedFilesReviewSpy.mock.calls.at(-1)?.[0];
        expect(nextProps.initialScrollTop).toBe(120);
    });

    it('does not persist near-identical review scroll offsets during large diff settling', async () => {
        vi.useFakeTimers();
        mockPaneScope.scopeState = {
            details: {
                tabState: {
                    'scmReview:working': {
                        scrollTop: 360,
                    },
                },
            },
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
                includedFiles: 0,
                pendingFiles: 0,
                untrackedFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        };

        await renderScreen(<SessionScmReviewDetailsView sessionId="s1" scopeId="session:s1" />);
        const reviewProps = changedFilesReviewSpy.mock.calls.at(-1)?.[0];
        expect(typeof reviewProps.onScrollTopChange).toBe('function');

        act(() => {
            reviewProps.onScrollTopChange(360.4);
        });
        await act(async () => {
            vi.advanceTimersByTime(250);
        });

        expect(mockPaneScope.setDetailsTabState).not.toHaveBeenCalled();

        act(() => {
            reviewProps.onScrollTopChange(362);
        });
        await act(async () => {
            vi.advanceTimersByTime(250);
        });

        expect(mockPaneScope.setDetailsTabState).toHaveBeenCalledTimes(1);
        expect(mockPaneScope.setDetailsTabState).toHaveBeenCalledWith('scmReview:working', {
            scrollTop: 362,
        });
    });

    it('does not persist equivalent collapsed path arrays during review settling', async () => {
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

        await renderScreen(<SessionScmReviewDetailsView sessionId="s1" scopeId="session:s1" />);
        const firstReviewProps = changedFilesReviewSpy.mock.calls.at(-1)?.[0];
        expect(typeof firstReviewProps.onCollapsedPathsChange).toBe('function');

        act(() => {
            firstReviewProps.onCollapsedPathsChange([]);
        });

        expect(mockPaneScope.setDetailsTabState).not.toHaveBeenCalled();

        mockPaneScope.scopeState = {
            details: {
                tabState: {
                    'scmReview:working': {
                        collapsedPaths: ['src/a.ts', 'src/b.ts'],
                    },
                },
            },
        };

        const { tree } = await renderScreen(<SessionScmReviewDetailsView sessionId="s1" scopeId="session:s1" />);
        const nextReviewProps = changedFilesReviewSpy.mock.calls.at(-1)?.[0];

        act(() => {
            nextReviewProps.onCollapsedPathsChange(['src/a.ts', 'src/b.ts']);
        });

        expect(mockPaneScope.setDetailsTabState).not.toHaveBeenCalled();

        act(() => {
            nextReviewProps.onCollapsedPathsChange(['src/a.ts']);
        });

        expect(mockPaneScope.setDetailsTabState).toHaveBeenCalledTimes(1);
        expect(mockPaneScope.setDetailsTabState).toHaveBeenCalledWith('scmReview:working', {
            collapsedPaths: ['src/a.ts'],
        });

        act(() => {
            tree.unmount();
        });
    });
});
