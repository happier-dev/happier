import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPartialStorageModuleMock, renderScreen } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { ReviewCommentV1 } from '@happier-dev/protocol';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSnapshot: any = null;
let mockProject: Readonly<{ id: string }> | null = null;
let reviewCommentsFeatureEnabled = false;
let scmWriteOperationsFeatureEnabled = false;
const changedFilesReviewSpy = vi.fn();
const useSessionRealtimeScmTranscriptConsumerMock = vi.hoisted(() => vi.fn());
const invalidateFromAutoRefreshSpy = vi.hoisted(() => vi.fn());
const invalidateFromAutoRefreshAndAwaitSpy = vi.hoisted(() => vi.fn());
const invalidateFromMutationAndAwaitSpy = vi.hoisted(() => vi.fn());
const invalidateFromUserSpy = vi.hoisted(() => vi.fn());
const serverFetchSpy = vi.hoisted(() => vi.fn());
const reviewCommentsSurfaceSpy = vi.hoisted(() => vi.fn());

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
            useSessionRealtimeScmTranscriptConsumer: useSessionRealtimeScmTranscriptConsumerMock,
            useSessionProjectScmTouchedPaths: () => [],
            useSessionProjectScmOperationLog: () => [],
            useProjectForSession: () => mockProject,
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

vi.mock('@/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides', () => ({
    BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS: {},
    BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_OVERRIDES: {},
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: serverFetchSpy,
}));

vi.mock('@/components/reviews/ReviewCommentsSessionSurface', () => ({
    ReviewCommentsSessionSurface: (props: any) => {
        reviewCommentsSurfaceSpy(props);
        return React.createElement('ReviewCommentsSessionSurface', props);
    },
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

vi.mock('@/components/workspaces/scm/review/ChangedFilesReview', () => ({
    ChangedFilesReview: (props: any) => {
        changedFilesReviewSpy(props);
        return React.createElement('ChangedFilesReview', props);
    },
}));

function reviewComment(overrides: Partial<ReviewCommentV1> = {}): ReviewCommentV1 {
    return {
        v: 1,
        id: overrides.id ?? 'comment-1',
        accountId: 'account-1',
        projectId: overrides.projectId ?? 'project-1',
        workspaceId: overrides.workspaceId,
        runId: overrides.runId,
        engineId: overrides.engineId,
        anchor: overrides.anchor ?? { kind: 'file', filePath: 'src/a.ts' },
        snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
        body: overrides.body ?? 'body',
        bodyVersion: 1,
        edits: [],
        author: overrides.author ?? { kind: 'plugin', pluginId: 'review-coderabbit' },
        state: overrides.state ?? 'open',
        flags: overrides.flags ?? {},
        dispositions: {},
        threadId: overrides.threadId ?? overrides.id ?? 'comment-1',
        transitions: [
            {
                transitionId: 'transition-1',
                toState: overrides.state ?? 'open',
                transitionedAt: 1,
                transitionedBy: { kind: 'plugin', pluginId: 'review-coderabbit' },
                serverRevision: 1,
            },
        ],
        createdAt: 1,
        updatedAt: overrides.updatedAt ?? 1,
        serverRevision: overrides.serverRevision ?? 1,
        ...overrides,
    };
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('SessionScmReviewDetailsView (snapshot SWR)', () => {
    beforeEach(() => {
        mockProject = null;
        reviewCommentsFeatureEnabled = false;
        scmWriteOperationsFeatureEnabled = false;
        changedFilesReviewSpy.mockClear();
        mockPaneScope.openDetailsTab.mockClear();
        mockPaneScope.setDetailsTabState.mockClear();
        mockPaneScope.scopeState = null;
        useSessionRealtimeScmTranscriptConsumerMock.mockClear();
        invalidateFromAutoRefreshSpy.mockClear();
        invalidateFromAutoRefreshAndAwaitSpy.mockClear();
        invalidateFromMutationAndAwaitSpy.mockClear();
        invalidateFromUserSpy.mockClear();
        serverFetchSpy.mockReset();
        reviewCommentsSurfaceSpy.mockClear();
        reviewDraftHandlers.onUpsertReviewCommentDraft.mockClear();
        reviewDraftHandlers.onDeleteReviewCommentDraft.mockClear();
        reviewDraftHandlers.onReviewCommentError.mockClear();
    });

    it('registers the mounted review surface as a realtime SCM transcript consumer', async () => {
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

        await renderScreen(React.createElement(SessionScmReviewDetailsView, { sessionId: 's1', scopeId: 'session:s1' }));

        expect(useSessionRealtimeScmTranscriptConsumerMock).toHaveBeenCalledWith('s1', mockSnapshot);
    }, 120_000);

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

        await renderScreen(React.createElement(SessionScmReviewDetailsView, { sessionId: 's1', scopeId: 'session:s1:0' }));

        expect(changedFilesReviewSpy).toHaveBeenCalledWith(expect.objectContaining({
            reviewCommentsEnabled: true,
            reviewCommentDrafts: [{ id: 'draft-1' }],
            onUpsertReviewCommentDraft: reviewDraftHandlers.onUpsertReviewCommentDraft,
            onDeleteReviewCommentDraft: reviewDraftHandlers.onDeleteReviewCommentDraft,
            onReviewCommentError: reviewDraftHandlers.onReviewCommentError,
        }));
    });

    it('mounts durable review comments in the session SCM review surface', async () => {
        reviewCommentsFeatureEnabled = true;
        mockProject = { id: 'project-1' };
        serverFetchSpy.mockImplementation(async () => jsonResponse({
            items: [reviewComment({ body: 'Durable session review comment.' })],
            cursor: null,
        }));
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

        const screen = await renderScreen(<SessionScmReviewDetailsView sessionId="s1" scopeId="session:s1:0" />);
        expect(screen.getTextContent()).not.toContain('Durable session review comment.');

        expect(reviewCommentsSurfaceSpy).toHaveBeenCalledWith(expect.objectContaining({
            projectId: 'project-1',
            sessionId: 's1',
            directWriteGrants: [],
            pendingDirectWriteGrantRequests: [],
            defaultPanelOpen: false,
            testID: 'review-comments-session',
            execute: expect.any(Function),
        }));

        const surfaceProps = reviewCommentsSurfaceSpy.mock.calls.at(-1)?.[0];
        await expect(surfaceProps.execute('reviews.comments.list', {
            projectId: surfaceProps.projectId,
            includeHistory: true,
        })).resolves.toEqual({
            items: [expect.objectContaining({ body: 'Durable session review comment.' })],
            cursor: null,
        });
        const [path] = serverFetchSpy.mock.calls.find(([candidatePath]) =>
            String(candidatePath).includes('/v1/reviews/comments?'),
        ) ?? [];
        expect(String(path)).toContain('/v1/reviews/comments?');
        expect(String(path)).toContain('projectId=project-1');
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

    it('debounces review scroll persistence while scrolling', async () => {
        vi.useFakeTimers();
        try {
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
            const reviewProps = changedFilesReviewSpy.mock.calls.at(-1)?.[0];

            act(() => {
                reviewProps.onScrollTopChange(128);
            });

            expect(mockPaneScope.setDetailsTabState).not.toHaveBeenCalled();

            act(() => {
                vi.advanceTimersByTime(249);
            });
            expect(mockPaneScope.setDetailsTabState).not.toHaveBeenCalled();

            act(() => {
                vi.advanceTimersByTime(1);
            });

            expect(mockPaneScope.setDetailsTabState).toHaveBeenCalledWith('scmReview:working', { scrollTop: 128 });
        } finally {
            vi.useRealTimers();
        }
    });

    it('flushes pending review scroll persistence on unmount', async () => {
        vi.useFakeTimers();
        try {
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

            const { tree } = await renderScreen(React.createElement(SessionScmReviewDetailsView, { sessionId: 's1', scopeId: 'session:s1:0' }));
            const reviewProps = changedFilesReviewSpy.mock.calls.at(-1)?.[0];

            act(() => {
                reviewProps.onScrollTopChange(96);
            });
            expect(mockPaneScope.setDetailsTabState).not.toHaveBeenCalled();

            act(() => {
                tree.unmount();
            });

            expect(mockPaneScope.setDetailsTabState).toHaveBeenCalledWith('scmReview:working', { scrollTop: 96 });
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the mounted review initial scroll position stable after persistence updates', async () => {
        vi.useFakeTimers();
        try {
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

            const { tree } = await renderScreen(React.createElement(SessionScmReviewDetailsView, { sessionId: 's1', scopeId: 'session:s1:0' }));
            const firstProps = changedFilesReviewSpy.mock.calls.at(-1)?.[0];
            expect(firstProps.initialScrollTop).toBe(120);

            act(() => {
                firstProps.onScrollTopChange(360);
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
                tree.update(React.createElement(SessionScmReviewDetailsView, { sessionId: 's1', scopeId: 'session:s1:1' }));
            });

            const nextProps = changedFilesReviewSpy.mock.calls.at(-1)?.[0];
            expect(nextProps.initialScrollTop).toBe(120);
        } finally {
            vi.useRealTimers();
        }
    });
});
