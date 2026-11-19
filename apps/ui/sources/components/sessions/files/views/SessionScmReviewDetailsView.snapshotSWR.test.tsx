import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewCommentCreateRequestV1Schema, ReviewCommentWorkspaceV1Schema, type ReviewCommentV1} from '@happier-dev/protocol/reviews/comments/v1';
import { ReviewCommentListRequestV1Schema} from '@happier-dev/protocol/reviews/comments/actions';
import { matchesReviewCommentListFilters} from '@happier-dev/protocol/reviews/comments/queries';
import { type PluginPermissionGrantV1} from '@happier-dev/protocol/plugins/permissions/grants';
import { type WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { flushHookEffects, standardCleanup, applyProjectAccountRowsFixture, invokeTestInstanceHandler } from '@/dev/testkit';
import { buildReviewCommentFixture, storePlainReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';

installSessionFilesViewBoundaries();
// Native recycler geometry is the platform boundary; review composition and scroll persistence remain real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<typeof import('@legendapp/list/react-native')>(), renderItems: true }).module;
});
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let servedReviewComments: readonly ReviewCommentV1[] = [];
let servedGrants: PluginPermissionGrantV1[] = [];
let homeRequests: Array<{ path: string; method: string; url: URL; body: unknown }> = [];
let requests: Array<{ path: string; method: string; accountId: string | null }> = [];
let pane: AppPaneScopeApi;
let pendingSnapshotResponses: Array<() => void> = [];
const tabKey = 'scmReview:working';
await prepareSessionFilesViewTestkit();
const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
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
        expect(createRequest).toBeDefined();
        expect(createRequest?.body).not.toHaveProperty('projectId');
        expect(response).toMatchObject({ comment: { body: 'Visible from the Project host.' } });
        expect(response).not.toHaveProperty('comment.projectId');
        const projectPanel = await fixture.render(<ReviewCommentsSessionSurface
            scope={surfaceProps.scope} workspaceId="wr_stable" workspace={surfaceProps.workspace} execute={surfaceProps.execute}
        />);
        expect(projectPanel.getTextContent()).toContain('Visible from the Project host.');
        const listRequest = homeRequests.filter(request => request.path === '/v1/reviews/comments' && request.method === 'GET').at(-1);
        expect(listRequest?.url.searchParams.get('projectId')).toBeNull();
        expect(JSON.parse(listRequest?.url.searchParams.get('workspace') ?? 'null')).toEqual({ machineId: 'm1', path: '/tmp/repo' });
    });

    it('creates the person’s reversible Session comment without confirmation by default', async () => {
        enableReviewComments();
        const { Modal } = await import('@/modal');
        const { ReviewCommentsSessionSurface } = await import('@/components/reviews/ReviewCommentsSessionSurface');
        const screen = await render();
        const surface = screen.tree.root.findByType(ReviewCommentsSessionSurface).props as React.ComponentProps<typeof ReviewCommentsSessionSurface>;
        // Canonical policy: packages/protocol/src/actions/actionApprovalPolicy.ts#requiresDefaultApprovalFloor.
        // Host present_user reversible UI intent is direct; explicit Actions Settings still win.
        const confirm = vi.mocked(Modal.confirm).mockReset().mockResolvedValue(false);
        const response = await surface.execute('reviews.comments.create', {
            workspace: surface.workspace, sessionId: surface.sessionId,
            anchor: { kind: 'file', filePath: 'src/a.ts' }, snapshot: { kind: 'none', capturedAt: 1 },
            body: 'Persist this reversible comment directly.', clientMutationId: 'session-direct',
        });
        expect(confirm).not.toHaveBeenCalled();
        expect(response).toMatchObject({ comment: { body: 'Persist this reversible comment directly.' } });
        expect(homeRequests.filter(request => request.path === '/v1/reviews/comments' && request.method === 'POST')).toHaveLength(1);
        expect(servedReviewComments).toEqual([expect.objectContaining({ body: 'Persist this reversible comment directly.' })]);
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
        expect(surface).not.toHaveProperty('projectId');
        expect(surface).toEqual(expect.objectContaining({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(fixture.home.id), accountId: 'alice' }, workspace: { machineId: 'm1', path: '/tmp/repo' }, sessionId: 's1',
            header: 'external', open: false, testID: 'review-comments-session', execute: expect.any(Function) }));
        expect(screen.getTextContent()).not.toContain('Durable session review comment.');
        await expect(surface.execute('reviews.comments.list', { workspace: surface.workspace, includeHistory: true })).resolves.toEqual({
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

    it('preserves the mounted review and restores the latest scroll position on remount', async () => {
        const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
        function Probe() { pane = useAppPaneScope('session:s1'); return null; }
        const screen = await fixture.render(<Probe />);
        act(() => { pane.setDetailsTabState(tabKey, { scrollTop: 120 }); });
        const element = (tick: number) => <React.Fragment><Probe /><Tick tick={tick} /><SessionScmReviewDetailsView serverId={fixture.home.id} sessionId="s1" scopeId="session:s1" /></React.Fragment>;
        await screen.update(fixture.wrap(element(0)));
        await flushHookEffects({ cycles: 20 });
        const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
        const mountedReview = screen.tree.root.findByType(ChangedFilesReview);
        const first = mountedReview.props;
        expect(first.initialScrollTop).toBe(120);
        vi.useFakeTimers();
        act(() => {
            invokeTestInstanceHandler(screen.findHostByTestId('scm-review-list'), 'onScroll', {
                nativeEvent: { contentOffset: { y: 360 } },
            });
            vi.advanceTimersByTime(250);
        });
        expect(scrollTop()).toBe(360);
        await screen.update(fixture.wrap(element(1)));
        expect(screen.tree.root.findByType(ChangedFilesReview)).toBe(mountedReview);
        // The seed can follow persistence without remounting the reading surface.
        // Closing and reopening Files must restore the latest position, not its first one.
        await screen.update(fixture.wrap(<Probe />));
        await screen.update(fixture.wrap(element(2)));
        expect(screen.tree.root.findByType(ChangedFilesReview).props.initialScrollTop).toBe(360);
    });
});
