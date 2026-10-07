import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewCommentCreateRequestV1Schema, ReviewCommentListRequestV1Schema, ReviewCommentWorkspaceV1Schema, matchesReviewCommentListFilters, type ReviewCommentV1, type PluginPermissionGrantV1, type WorkspaceRefV1 } from '@happier-dev/protocol';
import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import { buildReviewCommentFixture, storePlainReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';

installSessionFilesViewBoundaries();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let servedReviewComments: readonly ReviewCommentV1[] = [];
let servedGrants: PluginPermissionGrantV1[] = [];
let homeRequests: Array<{ path: string; method: string; url: URL; body: unknown }> = [];
let requests: Array<{ path: string; method: string; accountId: string | null }> = [];
let pane: AppPaneScopeApi;
let pendingSnapshotResponses: Array<() => void> = [];
const tabKey = 'scmReview:working';
beforeAll(prepareSessionFilesViewTestkit);
beforeEach(async () => {
    standardCleanup();
    servedReviewComments = [];
    servedGrants = [];
    homeRequests = [];
    requests = [];
    pendingSnapshotResponses = [];
    fixture = await createSessionFilesViewFixture({ rootPath: '/tmp/repo',
        // Hold only the network response; store-driven cases keep the refresh owner real.
        rpc: (request) => request.method === 'scm.status.snapshot' ? new Promise((resolve) => {
            pendingSnapshotResponses.push(() => resolve({ success: true, snapshot: fileViewSnapshot({ rootPath: '/tmp/repo' }) }));
        }) : undefined,
        request: async (url, init) => {
            const requestUrl = new URL(String(url));
            const path = requestUrl.pathname;
            const requestBody: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
            homeRequests.push({ path, method: init?.method ?? 'GET', url: requestUrl, body: requestBody });
            if (path === '/v1/plugins/permissions/grants/list') return Response.json({ grants: servedGrants, pendingRequests: [] });
            if (path === '/v1/reviews/comments') {
                const bearer = new Headers(init?.headers).get('authorization')?.split(' ')[1];
                const accountId = bearer ? (JSON.parse(Buffer.from(bearer.split('.')[1]!, 'base64url').toString()) as { sub: string }).sub : null;
                requests.push({ path, method: init?.method ?? 'GET', accountId });
                if (init?.method === 'POST') {
                    const { eventEnvelope: _envelope, ...input } = requestBody as Record<string, unknown>;
                    const created = ReviewCommentCreateRequestV1Schema.parse(input);
                    const comment: ReviewCommentV1 = { ...buildReviewCommentFixture({
                        accountId: 'alice', projectId: created.projectId, workspace: created.workspace, sessionId: created.sessionId,
                        anchor: created.anchor, snapshot: created.snapshot, body: created.body,
                        author: { kind: 'user', userId: 'alice' }, state: 'proposed',
                    }), accountId: 'alice', projectId: created.projectId, workspace: created.workspace };
                    servedReviewComments = [...servedReviewComments, comment];
                    return Response.json({ comment });
                }
                const workspace = requestUrl.searchParams.get('workspace');
                const filters = ReviewCommentListRequestV1Schema.parse({
                    projectId: requestUrl.searchParams.get('projectId') ?? undefined,
                    workspace: workspace ? ReviewCommentWorkspaceV1Schema.parse(JSON.parse(workspace)) : undefined,
                    includeHistory: true,
                });
                return Response.json({ items: servedReviewComments.filter(comment => matchesReviewCommentListFilters(comment, filters)).map(storePlainReviewCommentFixture), cursor: null });
            }
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            return new Response('{}', { status: 404 });
        },
    });
    fixture.setSnapshot(fileViewSnapshot({ rootPath: '/tmp/repo' }));
});
afterEach(async () => {
    vi.useRealTimers();
    for (const complete of pendingSnapshotResponses) complete();
    await flushHookEffects({ cycles: 20 });
    standardCleanup();
    await fixture?.dispose();
});

async function render(tick = 0) {
    const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    function Probe() { pane = useAppPaneScope('session:s1'); return null; }
    const element = (nextTick: number) => <React.Fragment><Probe /><Tick tick={nextTick} /><SessionScmReviewDetailsView serverId={fixture.home.id} sessionId="s1" scopeId="session:s1" /></React.Fragment>;
    const screen = await fixture.render(element(tick));
    return { ...screen, updateElement: screen.update, update: (nextTick: number) => screen.update(fixture.wrap(element(nextTick))) };
}
function Tick(_props: Readonly<{ tick: number }>) { return null; }
async function reviewProps(screen: Awaited<ReturnType<typeof render>>) {
    const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
    return screen.tree.root.findByType(ChangedFilesReview).props as React.ComponentProps<typeof ChangedFilesReview>;
}
function enableReviewComments() {
    const state = fixture.storage.getState();
    state.applySettingsLocal({ featureToggles: { ...state.settings.featureToggles, 'files.reviewComments': true } });
}
function scrollTop() { return (pane.scopeState?.details.tabState[tabKey] as { scrollTop?: number } | undefined)?.scrollTop; }

describe('SessionScmReviewDetailsView (snapshot SWR)', () => {
    it('creates a Session-scoped comment without a counter and lists it from the Project workspace scope', async () => {
        enableReviewComments();
        const { ReviewCommentsSessionSurface } = await import('@/components/reviews/ReviewCommentsSessionSurface');
        const screen = await render();
        const surfaceProps = screen.tree.root.findByType(ReviewCommentsSessionSurface).props as React.ComponentProps<typeof ReviewCommentsSessionSurface>;
        const response = await surfaceProps.execute('reviews.comments.create', {
            projectId: surfaceProps.projectId, workspace: surfaceProps.workspace, sessionId: surfaceProps.sessionId,
            anchor: { kind: 'file', filePath: 'src/a.ts' }, snapshot: { kind: 'none', capturedAt: 1 },
            body: 'Visible from the Project host.', clientMutationId: 'session-create',
        });
        const createRequest = homeRequests.find(request => request.path === '/v1/reviews/comments' && request.method === 'POST');
        expect(createRequest?.body).not.toHaveProperty('projectId');
        expect(response).not.toHaveProperty('comment.projectId');
        const projectPanel = await fixture.render(<ReviewCommentsSessionSurface
            workspaceId="wr_stable" workspace={surfaceProps.workspace} execute={surfaceProps.execute}
        />);
        expect(projectPanel.getTextContent()).toContain('Visible from the Project host.');
        const listRequest = homeRequests.filter(request => request.path === '/v1/reviews/comments' && request.method === 'GET').at(-1);
        expect(listRequest?.url.searchParams.get('projectId')).toBeNull();
        expect(JSON.parse(listRequest?.url.searchParams.get('workspace') ?? 'null')).toEqual({ machineId: 'm1', path: '/tmp/repo' });
    });

    it('finds a Project grant after counter reassignment and refuses another checkout or a missing ref', async () => {
        enableReviewComments();
        const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');
        const workspaceRef: WorkspaceRefV1 = {
            id: 'wr_stable', serverId: fixture.home.id, machineId: 'm1', rootPath: '/tmp/repo',
            label: null, createdAtMs: 1, lastOpenedAtMs: null,
        };
        fixture.storage.getState().applySettingsLocal({ workspaceRefsV1: [workspaceRef] });
        servedGrants = [{
            v: 1, id: 'grant-project', accountId: 'alice', grantedByUserId: 'alice',
            pluginId: 'review-coderabbit', capability: 'reviews.comments.write.direct',
            targetScope: { kind: 'project', projectId: workspaceRef.id }, authoritySource: { kind: 'bundled' },
            subject: { kind: 'general' }, status: 'active', grantedAt: 1, createdAt: 1, updatedAt: 1,
        }];
        const firstCounter = projectManager.getProjectForSession('s1', fixture.home.id)?.id;
        const { ReviewCommentsSessionSurface } = await import('@/components/reviews/ReviewCommentsSessionSurface');
        const screen = await render();
        expect(screen.tree.root.findByType(ReviewCommentsSessionSurface).props.permissionGrantError).toBeNull();
        await screen.pressByTestIdAsync('review-comments-session-header');
        expect(screen.findHostByTestId('review-comments-session-direct-write-grant-grant-project')).not.toBeNull();
        expect(homeRequests.find(request => request.path === '/v1/plugins/permissions/grants/list')?.body).toMatchObject({
            targetScope: { kind: 'project', projectId: 'wr_stable' },
        });
        projectManager.clear();
        projectManager.addSession({ ...fixture.session, id: 'other', metadata: { ...fixture.session.metadata, path: '/tmp/other' } }, { serverId: fixture.home.id });
        projectManager.addSession(fixture.session, { serverId: fixture.home.id });
        expect(projectManager.getProjectForSession('s1', fixture.home.id)?.id).not.toBe(firstCounter);
        await screen.update(1);
        expect(screen.findHostByTestId('review-comments-session-direct-write-grant-grant-project')).not.toBeNull();
        const otherRef = { ...workspaceRef, id: 'wr_other', rootPath: '/tmp/other' };
        fixture.storage.getState().applySettingsLocal({ workspaceRefsV1: [workspaceRef, otherRef] });
        const otherCheckoutSession = { ...fixture.session, metadata: { ...fixture.session.metadata, path: '/tmp/other' } };
        await act(async () => { fixture.storage.getState().applySessions([otherCheckoutSession]); });
        await screen.update(2);
        expect(screen.findHostByTestId('review-comments-session-direct-write-grant-grant-project')).toBeNull();
        fixture.storage.getState().applySettingsLocal({ workspaceRefsV1: [] });
        const requestCount = homeRequests.filter(request => request.path === '/v1/plugins/permissions/grants/list').length;
        await screen.update(3);
        expect(screen.findHostByTestId('review-comments-session-direct-write-grant-grant-project')).toBeNull();
        expect(homeRequests.filter(request => request.path === '/v1/plugins/permissions/grants/list')).toHaveLength(requestCount);
    });

    it('registers the mounted review surface as a realtime SCM transcript consumer', async () => {
        await render();
        const { readMountedSessionRealtimeScmConsumerScopes } = await import('@/sync/runtime/sessionRealtimeScmConsumers');
        expect(readMountedSessionRealtimeScmConsumerScopes()).toEqual(expect.arrayContaining([expect.objectContaining({
            serverId: fixture.home.id, sessionId: 's1', machineScopeId: 'm1', repoRoot: '/tmp/repo',
        })]));
        expect(readMountedSessionRealtimeScmConsumerScopes().every((scope) => scope.serverId === fixture.home.id)).toBe(true);
    }, 120_000);

    it('keeps last-known review content visible while snapshot is revalidating', async () => {
        const screen = await render();
        expect(screen.findHostByTestId('scm-review-list')).not.toBeNull();
        await act(async () => { fixture.setSnapshot(null); await screen.update(1); });
        expect(screen.findHostByTestId('scm-review-list')).not.toBeNull();
        const { ActivitySpinner } = await import('@/components/ui/feedback/ActivitySpinner');
        expect(screen.tree.root.findAllByType(ActivitySpinner)).toHaveLength(0);
    });

    it('uses the auto-refresh lease for the initial review snapshot warm-up', async () => {
        await render();
        expect(fixture.requests.filter((request) => request.method === 'scm.status.snapshot')).toEqual([
            expect.objectContaining({ targetId: 'm1', payload: expect.objectContaining({ cwd: '/tmp/repo' }) }),
        ]);
    });

    it('enables review comments for SCM review diffs when the session has a workspace scope', async () => {
        enableReviewComments();
        const { buildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
        const draft = { id: 'draft-1', filePath: 'src/a.ts', source: 'file' as const, anchor: { kind: 'fileLine' as const, startLine: 1 },
            snapshot: { selectedLines: ['line'], beforeContext: [], afterContext: [] }, body: 'Please revise this line.', createdAt: 1 };
        fixture.storage.getState().upsertWorkspaceReviewCommentDraft(buildWorkspaceCacheKey(fixture.scope), draft);
        const screen = await render();
        const props = await reviewProps(screen);
        expect(props.reviewCommentsEnabled).toBe(true);
        expect(props.reviewCommentDrafts).toEqual([draft]);
        expect(props.onUpsertReviewCommentDraft).toEqual(expect.any(Function));
        expect(props.onDeleteReviewCommentDraft).toEqual(expect.any(Function));
        expect(props.onReviewCommentError).toEqual(expect.any(Function));
        await act(async () => { props.onDeleteReviewCommentDraft?.('draft-1'); });
        expect((await reviewProps(screen)).reviewCommentDrafts).toEqual([]);
    });

    it.each([true, false])('mounts durable review comments with optional Project %j', async (hasProject) => {
        enableReviewComments();
        servedReviewComments = [buildReviewCommentFixture({ accountId: 'alice', sessionId: 's1', body: 'Durable session review comment.',
            workspace: { machineId: 'm1', path: '/tmp/repo' } })];
        const screen = await render();
        if (!hasProject) {
            const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');
            await act(async () => { projectManager.clear(); fixture.storage.setState({ sessions: { ...fixture.storage.getState().sessions } }); });
        }
        const { ReviewCommentsSessionSurface } = await import('@/components/reviews/ReviewCommentsSessionSurface');
        const surface = screen.tree.root.findByType(ReviewCommentsSessionSurface).props as React.ComponentProps<typeof ReviewCommentsSessionSurface>;
        const project = fixture.storage.getState().getProjectForSession('s1', fixture.home.id);
        expect(Boolean(project)).toBe(hasProject);
        expect(surface).toEqual(expect.objectContaining({ projectId: project?.id, workspace: { machineId: 'm1', path: '/tmp/repo' }, sessionId: 's1',
            directWriteGrants: [], pendingDirectWriteGrantRequests: [], defaultPanelOpen: false, testID: 'review-comments-session', execute: expect.any(Function) }));
        expect(screen.getTextContent()).not.toContain('Durable session review comment.');
        await expect(surface.execute('reviews.comments.list', { projectId: surface.projectId, workspace: surface.workspace, includeHistory: true })).resolves.toEqual({
            items: [expect.objectContaining({ body: 'Durable session review comment.' })], cursor: null,
        });
        expect(requests).toEqual([{ path: '/v1/reviews/comments', method: 'GET', accountId: 'alice' }]);
    });

    it('keeps review callbacks stable across unrelated parent rerenders', async () => {
        const screen = await render();
        const first = await reviewProps(screen);
        await screen.update(1);
        const next = await reviewProps(screen);
        expect(next.onFilePress).toBe(first.onFilePress);
        expect(next.onFilePressPinned).toBe(first.onFilePressPinned);
        expect(next.renderFileTrailingActions).toBe(first.renderFileTrailingActions);
    });

    it('offers the canonical per-file staging action directly in the session review list', async () => {
        fixture.storage.getState().applySettingsLocal({ scmCommitStrategy: 'git_staging' });
        const snapshot = fileViewSnapshot({ rootPath: '/tmp/repo', capabilities: { writeCommit: true, writeInclude: true, writeExclude: true } });
        fixture.setSnapshot(snapshot);
        const { ScmCommitSelectionToggleButton } = await import('@/components/sessions/sourceControl/commitSelection/ScmCommitSelectionToggleButton');
        const { selectScmChangedFiles } = await import('@/scm/scmStatusFiles');
        const staged = fileViewSnapshot({ entries: [{ path: 'src/staged.ts', kind: 'modified', includeStatus: 'modified', pendingStatus: 'unmodified',
            hasIncludedDelta: true, hasPendingDelta: false, previousPath: null,
            stats: { includedAdded: 1, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0, isBinary: false } }] });
        const file = selectScmChangedFiles(staged)[0]!;
        const screen = await render();
        const action = (await reviewProps(screen)).renderFileActions?.(file);
        if (!React.isValidElement<React.ComponentProps<typeof ScmCommitSelectionToggleButton>>(action)) throw new Error('No per-file staging action');
        expect(action.type).toBe(ScmCommitSelectionToggleButton);
        expect(action.props).toEqual(expect.objectContaining({ sessionId: 's1', sessionPath: '/tmp/repo', snapshot,
            scmWriteEnabled: true, commitStrategy: 'git_staging', file, selectedForCommit: true, surface: 'files' }));
    });

    it('debounces review scroll persistence while scrolling', async () => {
        const screen = await render();
        const props = await reviewProps(screen);
        vi.useFakeTimers();
        act(() => { props.onScrollTopChange?.(128); });
        expect(scrollTop()).toBeUndefined();
        act(() => { vi.advanceTimersByTime(249); });
        expect(scrollTop()).toBeUndefined();
        act(() => { vi.advanceTimersByTime(1); });
        expect(scrollTop()).toBe(128);
    });

    it('flushes pending review scroll persistence on unmount', async () => {
        const screen = await render();
        const props = await reviewProps(screen);
        vi.useFakeTimers();
        act(() => { props.onScrollTopChange?.(96); });
        expect(scrollTop()).toBeUndefined();
        const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
        function Probe() { pane = useAppPaneScope('session:s1'); return null; }
        // The pane owner remains mounted to receive its child's unmount flush.
        await screen.updateElement(fixture.wrap(<Probe />));
        expect(scrollTop()).toBe(96);
    });

    it('keeps the mounted review initial scroll position stable after persistence updates', async () => {
        const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
        function Probe() { pane = useAppPaneScope('session:s1'); return null; }
        const screen = await fixture.render(<Probe />);
        act(() => { pane.setDetailsTabState(tabKey, { scrollTop: 120 }); });
        const element = (tick: number) => <React.Fragment><Probe /><Tick tick={tick} /><SessionScmReviewDetailsView serverId={fixture.home.id} sessionId="s1" scopeId="session:s1" /></React.Fragment>;
        await screen.update(fixture.wrap(element(0)));
        await flushHookEffects({ cycles: 20 });
        const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
        const first = screen.tree.root.findByType(ChangedFilesReview).props;
        expect(first.initialScrollTop).toBe(120);
        const onScrollTopChange = first.onScrollTopChange;
        if (!onScrollTopChange) throw new Error('Expected the mounted review scroll persistence callback');
        vi.useFakeTimers();
        act(() => { onScrollTopChange(360); vi.advanceTimersByTime(250); });
        expect(scrollTop()).toBe(360);
        await screen.update(fixture.wrap(element(1)));
        expect(screen.tree.root.findByType(ChangedFilesReview).props.initialScrollTop).toBe(120);
    });
});
