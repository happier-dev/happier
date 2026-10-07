import * as React from 'react';
import 'fake-indexeddb/auto';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPartialStorageModuleMock, renderScreen } from '@/dev/testkit';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { ReviewCommentCreateRequestV1Schema, ReviewCommentListRequestV1Schema, ReviewCommentWorkspaceV1Schema, matchesReviewCommentListFilters, type ReviewCommentV1, type PluginPermissionGrantV1, type WorkspaceRefV1 } from '@happier-dev/protocol';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { getStorage } from '@/sync/domains/state/storage';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';
import { serveActionHomes, type ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { storePlainReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';

// Loaded at the assertion, not at the top: an eager import would evaluate the spinner's module
// graph before this file's mocks and per-test setup have run.
const loadActivitySpinner = async () => (await import('@/components/ui/feedback/ActivitySpinner')).ActivitySpinner;

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSnapshot: any = null;
let mockProject: Readonly<{ id: string }> | null = null;
let reviewCommentsFeatureEnabled = false;
let scmWriteOperationsFeatureEnabled = false;
let mockScmCommitStrategy: 'atomic' | 'git_staging' = 'atomic';
const changedFilesReviewSpy = vi.fn();
const useSessionRealtimeScmTranscriptConsumerMock = vi.hoisted(() => vi.fn());
const invalidateFromAutoRefreshSpy = vi.hoisted(() => vi.fn());
const invalidateFromAutoRefreshAndAwaitSpy = vi.hoisted(() => vi.fn());
const invalidateFromMutationAndAwaitSpy = vi.hoisted(() => vi.fn());
const invalidateFromUserSpy = vi.hoisted(() => vi.fn());
let homeRequests: ServedHomeRequest[] = [];
let servedReviewComments: readonly ReviewCommentV1[] = [];
let disposeHome: (() => void) | null = null;
let servedHomeId = '';
let workspaceRefs: WorkspaceRefV1[] = [];
let servedGrants: PluginPermissionGrantV1[] = [];
let useManagedProject = false;

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
            useSessionWorkspacePath: () => '/tmp/repo',
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionProjectScmSnapshot: () => mockSnapshot,
            useSessionProjectScmSnapshotError: () => null,
            useSessionRealtimeScmTranscriptConsumer: useSessionRealtimeScmTranscriptConsumerMock,
            useWorkspaceScmTouchedPathsForSession: () => [],
            useSessionProjectScmOperationLog: () => [],
            useSessionProjectScmCommitSelectionPaths: () => [],
            useSessionProjectScmCommitSelectionPatches: () => [],
            useProjectForSession: () => useManagedProject ? projectManager.getProjectForSession('s1') : mockProject,
            useProjectSessions: () => [],
            useSetting: (key: string) => key === 'workspaceRefsV1' ? workspaceRefs : key === 'scmCommitStrategy' ? mockScmCommitStrategy : 25,
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
        sessionAttribution: { confidence: 'unknown', reason: 'unavailable' },
        sessionCheckpointOverlap: 'unknown',
        allRepositoryChangedFiles: [],
        turnAttributedFiles: [],
        turnRepositoryOnlyFiles: [],
        sessionAttributedFiles: [],
        repositoryOnlyFiles: [],

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

describe('SessionScmReviewDetailsView (snapshot SWR)', () => {
    beforeEach(async () => {
        await prepareSessionDraftPersistenceStorage();
        servedReviewComments = [];
        const served = await serveActionHomes({
            homes: [{ key: 'scm', serverUrl: 'https://scm-review.test', accountId: 'account-1' }],
            route: (request) => {
                if (request.path === '/v1/reviews/comments') {
                    if (request.method === 'POST') {
                        // The HTTP boundary returns a plain comment; request validation, Account
                        // binding, event sealing and query matching all remain production logic.
                        const { eventEnvelope: _envelope, ...input } = request.body as Record<string, unknown>;
                        const created = ReviewCommentCreateRequestV1Schema.parse(input);
                        const comment = reviewComment({
                            projectId: created.projectId, workspace: created.workspace, sessionId: created.sessionId,
                            anchor: created.anchor, snapshot: created.snapshot, body: created.body,
                            author: { kind: 'user', userId: 'account-1' }, state: 'proposed',
                        });
                        servedReviewComments = [...servedReviewComments, comment];
                        return Response.json({ comment });
                    }
                    const workspace = request.url.searchParams.get('workspace');
                    const filters = ReviewCommentListRequestV1Schema.parse({
                        projectId: request.url.searchParams.get('projectId') ?? undefined,
                        workspace: workspace ? ReviewCommentWorkspaceV1Schema.parse(JSON.parse(workspace)) : undefined,
                        includeHistory: true,
                    });
                    return Response.json({ items: servedReviewComments.filter((comment) => matchesReviewCommentListFilters(comment, filters)).map(storePlainReviewCommentFixture), cursor: null });
                }
                if (request.path === '/v1/plugins/permissions/grants/list') {
                    // Transport fixture deliberately returns all Account grants: the real host must
                    // refuse a grant for another checkout even if the response includes it.
                    return Response.json({ grants: servedGrants, pendingRequests: [] });
                }
                return undefined;
            },
        });
        homeRequests = served.requests;
        servedHomeId = served.homes.scm!.id;
        disposeHome = served.dispose;
        workspaceRefs = [];
        servedGrants = [];
        useManagedProject = false;
        projectManager.clear();
        const machine = {
            id: 'machine-1', seq: 0, createdAt: 0, updatedAt: 0, active: true, activeAt: 0,
            metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
        } satisfies Machine;
        getStorage().setState({
            sessions: { s1: { ...mockSession, id: 's1', serverId: servedHomeId, metadata: { path: '/tmp/repo', machineId: 'machine-1', host: '' } } },
            machines: { [machine.id]: machine },
            machineListByServerId: { [servedHomeId]: [machine] },
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
            sessionListIndexByServerId: {},
        });
        mockSnapshot = {
            fetchedAt: 1, projectKey: 'm1:/repo',
            repo: { isRepo: true, rootPath: '/tmp/repo', backendId: 'git', mode: '.git' },
            capabilities: { readLog: true },
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            stashCount: 0, hasConflicts: false, entries: [],
            totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
        };
        mockProject = null;
        reviewCommentsFeatureEnabled = false;
        scmWriteOperationsFeatureEnabled = false;
        mockScmCommitStrategy = 'atomic';
        changedFilesReviewSpy.mockClear();
        mockPaneScope.openDetailsTab.mockClear();
        mockPaneScope.setDetailsTabState.mockClear();
        mockPaneScope.scopeState = null;
        useSessionRealtimeScmTranscriptConsumerMock.mockClear();
        invalidateFromAutoRefreshSpy.mockClear();
        invalidateFromAutoRefreshAndAwaitSpy.mockClear();
        invalidateFromMutationAndAwaitSpy.mockClear();
        invalidateFromUserSpy.mockClear();
        reviewDraftHandlers.onUpsertReviewCommentDraft.mockClear();
        reviewDraftHandlers.onDeleteReviewCommentDraft.mockClear();
        reviewDraftHandlers.onReviewCommentError.mockClear();
    });

    it('creates a Session-scoped comment without a counter and lists it from the Project workspace scope', async () => {
        reviewCommentsFeatureEnabled = true;
        mockProject = { id: 'project_1' };
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
        const { ReviewCommentsSessionSurface } = await import('@/components/reviews/ReviewCommentsSessionSurface');
        const screen = await renderScreen(<SessionScmReviewDetailsView serverId={servedHomeId} sessionId="s1" scopeId="session:s1:0" />);
        // ReactTestInstance erases props; restore the concrete mounted component's contract.
        const surfaceProps = screen.findByType(ReviewCommentsSessionSurface).props as React.ComponentProps<typeof ReviewCommentsSessionSurface>;
        const response = await surfaceProps.execute('reviews.comments.create', {
            projectId: surfaceProps.projectId,
            workspace: surfaceProps.workspace,
            sessionId: surfaceProps.sessionId,
            anchor: { kind: 'file', filePath: 'src/a.ts' },
            snapshot: { kind: 'none', capturedAt: 1 },
            body: 'Visible from the Project host.', clientMutationId: 'session-create',
        });
        const createRequest = homeRequests.find((request) => request.path === '/v1/reviews/comments' && request.method === 'POST');
        expect(createRequest?.body).not.toHaveProperty('projectId');
        expect(response).not.toHaveProperty('comment.projectId');
        const projectPanel = await renderScreen(<ReviewCommentsSessionSurface
            workspaceId="wr_stable" workspace={surfaceProps.workspace} execute={surfaceProps.execute}
        />);
        expect(projectPanel.getTextContent()).toContain('Visible from the Project host.');
        expect(homeRequests.at(-1)?.url.searchParams.get('projectId')).toBeNull();
        expect(JSON.parse(homeRequests.at(-1)?.url.searchParams.get('workspace') ?? 'null')).toEqual({ machineId: 'machine-1', path: '/tmp/repo' });
    });

    afterEach(() => {
        disposeHome?.();
        disposeHome = null;
        retireActiveServerAccountScopeLifetime();
        invalidateAccountEncryptionModeCache();
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

        await renderScreen(React.createElement(SessionScmReviewDetailsView, { sessionId: 's1', scopeId: 'session:s1', serverId: 'home-a' }));

        // The exact Home travels with the registration: another Home hosting the same Session
        // id must not receive this surface's realtime SCM routing.
        expect(useSessionRealtimeScmTranscriptConsumerMock)
            .toHaveBeenCalledWith({ serverId: 'home-a', sessionId: 's1' }, mockSnapshot);
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
        expect(tree.findAllByType(await loadActivitySpinner())).toHaveLength(0);
    });

    it('uses the auto-refresh lease for the initial review snapshot warm-up', async () => {
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');

        await renderScreen(<SessionScmReviewDetailsView sessionId="s1" scopeId="session:s1" />);

        expect(invalidateFromAutoRefreshSpy).toHaveBeenCalledTimes(1);
        expect(invalidateFromAutoRefreshSpy.mock.calls[0]?.[0]).toBe('s1');
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

    it.each([{ id: 'project-1' }, null])('mounts durable review comments with optional Project %j', async (selectedProject) => {
        reviewCommentsFeatureEnabled = true;
        mockProject = selectedProject;
        servedReviewComments = [reviewComment({ body: 'Durable session review comment.', workspace: { machineId: 'machine-1', path: '/tmp/repo' } })];
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

        const screen = await renderScreen(<SessionScmReviewDetailsView serverId={servedHomeId} sessionId="s1" scopeId="session:s1:0" />);
        expect(screen.getTextContent()).not.toContain('Durable session review comment.');

        const { ReviewCommentsSessionSurface } = await import('@/components/reviews/ReviewCommentsSessionSurface');
        // ReactTestInstance erases props; restore the concrete mounted component's contract.
        const surfaceProps = screen.findByType(ReviewCommentsSessionSurface).props as React.ComponentProps<typeof ReviewCommentsSessionSurface>;
        expect(surfaceProps.projectId).toBeUndefined();
        expect(surfaceProps).toEqual(expect.objectContaining({
            workspace: { machineId: 'machine-1', path: '/tmp/repo' },
            sessionId: 's1',
            directWriteGrants: [],
            pendingDirectWriteGrantRequests: [],
            defaultPanelOpen: false,
            testID: 'review-comments-session',
            execute: expect.any(Function),
        }));

        await expect(surfaceProps.execute('reviews.comments.list', {
            projectId: surfaceProps.projectId,
            workspace: surfaceProps.workspace,
            includeHistory: true,
        })).resolves.toEqual({
            items: [expect.objectContaining({ body: 'Durable session review comment.' })],
            cursor: null,
        });
        expect(homeRequests.filter((request) => request.path === '/v1/reviews/comments')).toEqual([
            expect.objectContaining({ home: 'scm', accountId: 'account-1', method: 'GET' }),
        ]);
    });

    it('finds a Project grant after counter reassignment and refuses another checkout or a missing ref', async () => {
        reviewCommentsFeatureEnabled = true;
        useManagedProject = true;
        const workspaceRef: WorkspaceRefV1 = {
            id: 'wr_stable', serverId: servedHomeId, machineId: 'machine-1', rootPath: '/tmp/repo',
            label: null, createdAtMs: 1, lastOpenedAtMs: null,
        };
        workspaceRefs = [workspaceRef];
        servedGrants = [{
            v: 1, id: 'grant-project', accountId: 'account-1', grantedByUserId: 'account-1',
            pluginId: 'review-coderabbit', capability: 'reviews.comments.write.direct',
            targetScope: { kind: 'project', projectId: workspaceRef.id }, authoritySource: { kind: 'bundled' },
            subject: { kind: 'general' }, status: 'active',
            grantedAt: 1, createdAt: 1, updatedAt: 1,
        }];
        const session = { ...mockSession, id: 's1', metadata: { path: '/tmp/repo', machineId: 'machine-1', host: '' } } satisfies Session;
        projectManager.addSession(session, { serverId: servedHomeId });
        const firstCounter = projectManager.getProjectForSession('s1')?.id;
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
        const { ReviewCommentsSessionSurface } = await import('@/components/reviews/ReviewCommentsSessionSurface');
        const screen = await renderScreen(<SessionScmReviewDetailsView serverId={servedHomeId} sessionId="s1" scopeId="session:s1:0" />);
        expect(screen.findByType(ReviewCommentsSessionSurface).props.permissionGrantError).toBeNull();
        await screen.pressByTestIdAsync('review-comments-session-header');
        expect(screen.findHostByTestId('review-comments-session-direct-write-grant-grant-project')).not.toBeNull();
        expect(homeRequests.find((request) => request.path === '/v1/plugins/permissions/grants/list')?.body).toMatchObject({
            targetScope: { kind: 'project', projectId: 'wr_stable' },
        });

        projectManager.clear();
        projectManager.addSession({ ...session, id: 'other', metadata: { ...session.metadata, path: '/tmp/other' } }, { serverId: servedHomeId });
        projectManager.addSession(session, { serverId: servedHomeId });
        expect(projectManager.getProjectForSession('s1')?.id).not.toBe(firstCounter);
        await screen.update(<SessionScmReviewDetailsView serverId={servedHomeId} sessionId="s1" scopeId="session:s1:restart" />);
        expect(screen.findHostByTestId('review-comments-session-direct-write-grant-grant-project')).not.toBeNull();

        workspaceRefs = [workspaceRef, { ...workspaceRef, id: 'wr_other', rootPath: '/tmp/other' }];
        const otherCheckoutSession = { ...session, serverId: servedHomeId, metadata: { ...session.metadata, path: '/tmp/other' } };
        projectManager.addSession(otherCheckoutSession, { serverId: servedHomeId });
        await act(async () => { getStorage().setState({ sessions: { s1: otherCheckoutSession } }); });
        await screen.update(<SessionScmReviewDetailsView serverId={servedHomeId} sessionId="s1" scopeId="session:s1:other" />);
        expect(screen.findHostByTestId('review-comments-session-direct-write-grant-grant-project')).toBeNull();
        workspaceRefs = [];
        const requestCount = homeRequests.filter((request) => request.path === '/v1/plugins/permissions/grants/list').length;
        await screen.update(<SessionScmReviewDetailsView serverId={servedHomeId} sessionId="s1" scopeId="session:s1:no-ref" />);
        expect(screen.findHostByTestId('review-comments-session-direct-write-grant-grant-project')).toBeNull();
        expect(homeRequests.filter((request) => request.path === '/v1/plugins/permissions/grants/list')).toHaveLength(requestCount);
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

    it('offers the canonical per-file staging action directly in the session review list', async () => {
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
