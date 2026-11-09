import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, invokeTestInstanceHandler, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';

let recycler: import('@/dev/testkit/mocks/legendList').CapturingLegendListMockState;
installSessionFilesViewBoundaries({ platformOS: 'web', onRecycler: state => { recycler = state; } });
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
beforeAll(prepareSessionFilesViewTestkit);
afterEach(async () => {
    vi.unstubAllGlobals();
    standardCleanup();
    if (fixture) {
        const { retireScmDiffSummaryScope } = await import('@/sync/ops/scmDiffSummary/generate');
        retireScmDiffSummaryScope({ serverId: fixture.home.id, accountId: 'alice' });
    }
    await fixture?.dispose();
});

function snapshotWithFile(path: string) {
    return fileViewSnapshot({ rootPath: '/tmp/repo', entries: [{
        path, kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
        hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
        stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
    }], capabilities: { readDiffFile: true, writeCommit: true } });
}

describe('SessionScmReviewDetailsView (exact Home)', () => {
    it.each([
        { contentHeight: 769, expectedTop: 300, revealBeforeLoad: false },
        { contentHeight: 654, expectedTop: 250, revealBeforeLoad: false },
        { contentHeight: 769, expectedTop: 0, revealBeforeLoad: true },
    ])('restores a captured working-tree comparison on a newly measured Files viewport ($contentHeight → $expectedTop)', async ({ contentHeight, expectedTop, revealBeforeLoad }) => {
        // Browser layout is the boundary: a newly mounted recycler initially has no scroll range.
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const createViewport = (scrollHeight: number) => {
            let top = 0;
            return { clientHeight: 404, scrollHeight, clientWidth: 900, scrollWidth: 900, parentElement: null,
                style: { setProperty: vi.fn() }, querySelectorAll: () => [],
                get scrollTop() { return top; },
                set scrollTop(value: number) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
            };
        };
        let scroller = createViewport(769);
        vi.stubGlobal('window', { document: { querySelector: (selector: string) => selector === '[data-testid="scm-review-list"]' ? scroller : null },
            getComputedStyle: () => ({ overflowY: 'auto', overflowX: 'hidden' }) });
        const flushFrame = async () => {
            const pending = frames.splice(0);
            await act(async () => { for (const callback of pending) callback(0); });
        };
        fixture = await createSessionFilesViewFixture({ rootPath: '/tmp/repo' });
        const { ScmDiffSummaryResultSchema } = await import('@happier-dev/protocol/scm');
        const { loadSavedScmDiffSummaryResult } = await import('@/sync/ops/scmDiffSummary/generate');
        const result = ScmDiffSummaryResultSchema.parse({ resultId: 'captured-scroll', revision: 0, canUndo: false,
            output: { success: true, resultId: 'captured-scroll', revision: 0, sourceKey: 'captured-scroll',
                metadata: { sourceKey: 'captured-scroll', source: { kind: 'workingTree' } }, requestedOutputs: ['walkthrough'],
                comparison: { id: 'captured-scroll', source: { kind: 'workingTree' }, repository: { rootPath: '/tmp/repo' }, endpoints: {},
                    inventory: { state: 'complete', reasons: [], files: [{ path: 'README.md', changeKind: 'modified',
                        binary: false, generated: false, lockfile: false,
                        evidence: { state: 'available', unifiedDiff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n' }, occurrences: [{
                            id: 'readme-change', alias: 'c1', path: 'README.md', position: 0,
                            before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 },
                        }] }] } },
                outputs: { walkthrough: { state: 'pending' } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: ['readme-change'] } } });
        loadSavedScmDiffSummaryResult({ sessionId: 's1', scope: { serverId: fixture.home.id, accountId: 'alice' }, result, savedAtMs: 1 });
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
        const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
        const { readSessionScmReviewTarget } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
        function Host() {
            const [target, setTarget] = React.useState<import('@/components/sessions/panes/details/sessionDetailsTabBuilders').SessionScmReviewTarget>({
                comparison: { kind: 'workingTree', comparisonId: 'captured-scroll' }, view: 'files',
            });
            return <SessionScmReviewDetailsView sessionId="s1" serverId={fixture.home.id} scopeId="session:s1" target={target}
                onOpenDetailsTab={tab => { if (tab.kind === 'scmReview') setTarget(readSessionScmReviewTarget(tab.resource)); }} />;
        }
        const screen = await fixture.render(<Host />);
        await flushFrame();
        await screen.pressByTestIdAsync('scm-change-collapse-README.md');
        for (let frame = 0; frame < 12; frame += 1) await flushFrame();
        scroller.scrollTop = 300;
        recycler.refHandle.scrollToOffset.mockImplementation(({ offset }: { offset: number }) => {
            scroller.scrollTop = offset;
            return Promise.resolve();
        });
        await act(async () => invokeTestInstanceHandler(screen.findHostByTestId('scm-review-list'), 'onScroll', {
            nativeEvent: { contentOffset: { y: 300 } },
        }));
        await screen.pressByTestIdAsync('scm-comparison-view:walkthrough');
        const detachedScroller = scroller;
        scroller = createViewport(404);
        await screen.pressByTestIdAsync('scm-comparison-view:files');
        expect(screen.findByType(ChangedFilesReview).props.initialScrollTop).toBe(300);
        await act(async () => invokeTestInstanceHandler(screen.findHostByTestId('scm-review-list'), 'onScroll', {
            nativeEvent: { contentOffset: { y: 0 } },
        }));
        for (let frame = 0; frame < 20; frame += 1) await flushFrame();
        expect(screen.findByType(ChangedFilesReview).props.initialScrollTop).toBe(300);
        expect(scroller.scrollTop).toBe(0);
        scroller.scrollHeight = contentHeight;
        if (revealBeforeLoad) {
            const { activeReviewFileKeyForSession, requestActiveReviewFile } = await import('@/components/workspaces/scm/review/activeReviewFile');
            recycler.refHandle.scrollToIndex.mockClear();
            recycler.refHandle.scrollToIndex.mockImplementation(() => { scroller.scrollTop = 0; return Promise.resolve(); });
            await act(async () => {
                expect(requestActiveReviewFile(activeReviewFileKeyForSession('s1', fixture.home.id), 'README.md')).toBe(true);
            });
            await vi.waitFor(() => expect(recycler.refHandle.scrollToIndex).toHaveBeenCalled());
            for (let frame = 0; frame < 12; frame += 1) await flushFrame();
        }
        await act(async () => recycler.props.onLoad?.({ elapsedTimeInMs: 0 }));
        for (let frame = 0; frame < 12; frame += 1) await flushFrame();
        expect(scroller.scrollTop).toBe(expectedTop);
        expect(detachedScroller.scrollTop).toBe(300);
        expect(screen.findByType(ChangedFilesReview).props.initialCollapsedPaths).toEqual(revealBeforeLoad ? [] : ['README.md']);
    });
    it('keeps a restored pending comparison count before the live checkout snapshot arrives', async () => {
        const pendingSnapshots: Array<() => void> = [];
        fixture = await createSessionFilesViewFixture({ rootPath: '/tmp/repo', rpc: request =>
            request.method === 'scm.status.snapshot' ? new Promise(resolve => pendingSnapshots.push(() =>
                resolve({ success: true, snapshot: fileViewSnapshot({ rootPath: '/tmp/repo' }) }))) : undefined });
        const { ScmDiffSummaryResultSchema } = await import('@happier-dev/protocol/scm');
        const { loadSavedScmDiffSummaryResult } = await import('@/sync/ops/scmDiffSummary/generate');
        const result = ScmDiffSummaryResultSchema.parse({ resultId: 'restored-pending-count', revision: 0, canUndo: false,
            output: { success: true, resultId: 'restored-pending-count', revision: 0, sourceKey: 'saved-pending-count',
                metadata: { sourceKey: 'saved-pending-count', source: { kind: 'workingTree' } }, requestedOutputs: ['walkthrough'],
                comparison: { id: 'saved-pending-count', source: { kind: 'workingTree' }, repository: { rootPath: '/tmp/repo' }, endpoints: {},
                    inventory: { state: 'complete', reasons: [], files: [{ path: 'src/saved.ts', changeKind: 'modified',
                        binary: false, generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: '' }, occurrences: [] }] } },
                outputs: { walkthrough: { state: 'pending' } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } });
        loadSavedScmDiffSummaryResult({ sessionId: 's1', scope: { serverId: fixture.home.id, accountId: 'alice' }, result, savedAtMs: 1 });
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
        const { ScmComparisonScopePicker } = await import('@/components/sessions/files/comparison/ScmComparisonScopePicker');
        const screen = await fixture.render(<SessionScmReviewDetailsView sessionId="s1" serverId={fixture.home.id}
            scopeId="session:s1" target={{ comparison: { kind: 'workingTree' }, view: 'walkthrough' }} />);
        try {
            expect(screen.findByType(ScmComparisonScopePicker).props.fileCount).toBe(1);
            expect(screen.findByType(ScmComparisonScopePicker).props.options.find((option: { sourceKind: string }) => option.sourceKind === 'workingTree').fileCount).toBe(1);
        } finally {
            await act(async () => {
                for (const complete of pendingSnapshots) complete();
                await flushHookEffects();
            });
        }
    });

    it('promotes a pending file from a historical Walkthrough to working-tree Files through the same focus owner', async () => {
        const snapshot = snapshotWithFile('src/pending.ts');
        fixture = await createSessionFilesViewFixture({ rootPath: '/tmp/repo', rpc: request =>
            request.method === 'scm.status.snapshot' ? { success: true, snapshot } : undefined });
        const { WorkspaceScmReviewDetailsView } = await import('@/components/projects/panes/details/views/WorkspaceScmReviewDetailsView');
        const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
        const { activeReviewFileKeyForWorkspace, requestActiveReviewFileForComparison, readActiveReviewFile } = await import('@/components/workspaces/scm/review/activeReviewFile');
        function Host() {
            const [target, setTarget] = React.useState<NonNullable<React.ComponentProps<typeof WorkspaceScmReviewDetailsView>['onSelectTarget']> extends (input: infer T) => void ? T : never>({
                comparison: { kind: 'branch', head: 'feature', base: 'main' }, view: 'walkthrough', explain: false,
            });
            return <WorkspaceScmReviewDetailsView scopeId="project:workspace"
                machineId="m1" serverId={fixture.home.id} rootPath="/tmp/repo" {...target} onSelectTarget={setTarget} />;
        }
        const screen = await fixture.render(<Host />);
        const key = activeReviewFileKeyForWorkspace(fixture.scope);
        expect(requestActiveReviewFileForComparison(key, 'src/pending.ts', { kind: 'workingTree' })).toBe(true);
        const { flushHookEffects } = await import('@/dev/testkit');
        await flushHookEffects({ cycles: 20 });
        expect(screen.findByTestId('workspace-walkthrough')).toBeNull();
        expect(screen.findByType(ChangedFilesReview).props.allRepositoryChangedFiles.map((file: { fullPath: string }) => file.fullPath)).toEqual(['src/pending.ts']);
        expect(readActiveReviewFile(key).focusRequest).toMatchObject({ path: 'src/pending.ts' });
        expect(readActiveReviewFile(key).focusRequest?.comparison).toBeUndefined();
    });
    it('uses the same Files and Walkthrough body for a workspace without any Session', async () => {
        // Browser recycler geometry is the platform boundary. The review's actual restoration path must
        // move a new viewport, rather than merely pass the retained offset back into its props.
        const createViewport = () => ({ scrollTop: 0, clientHeight: 404, scrollHeight: 769,
            clientWidth: 900, scrollWidth: 900, parentElement: null,
            style: { setProperty: vi.fn() }, querySelectorAll: () => [],
        });
        let scroller = createViewport();
        vi.stubGlobal('window', { document: { querySelector: (selector: string) => selector === '[data-testid="scm-review-list"]' ? scroller : null },
            getComputedStyle: () => ({ overflowY: 'auto', overflowX: 'hidden' }) });
        const snapshot = snapshotWithFile('src/workspace.ts');
        fixture = await createSessionFilesViewFixture({ rootPath: '/tmp/repo', rpc: (request) =>
            request.method === 'scm.status.snapshot' ? { success: true, snapshot } : undefined });
        fixture.setSnapshot(snapshot);
        fixture.storage.setState({ sessions: {} });
        const { WorkspaceScmReviewDetailsView } = await import('@/components/projects/panes/details/views/WorkspaceScmReviewDetailsView');
        const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
        const screen = await fixture.render(<WorkspaceScmReviewDetailsView scopeId="project:workspace-row"
            machineId="m1"
            rootPath="/tmp/repo" serverId={fixture.home.id} view="files" comparison={{ kind: 'workingTree' }} />);
        recycler.refHandle.scrollToOffset.mockImplementation(({ offset }: { offset: number }) => {
            scroller.scrollTop = offset;
            return Promise.resolve();
        });
        const review = screen.findByType(ChangedFilesReview).props as React.ComponentProps<typeof ChangedFilesReview>;
        expect(review.allRepositoryChangedFiles.map((file) => file.fullPath)).toEqual(['src/workspace.ts']);
        expect(review.sessionId).toBeUndefined();
        const { activeReviewFileKeyForWorkspace, publishActiveReviewFile, readActiveReviewFile, requestActiveReviewFile } = await import('@/components/workspaces/scm/review/activeReviewFile');
        expect(review.reviewScopeKey).toBe(activeReviewFileKeyForWorkspace(fixture.scope));
        expect(screen.findByTestId('scm-comparison-view:walkthrough')).not.toBeNull();
        const activeKey = activeReviewFileKeyForWorkspace(fixture.scope);
        await act(async () => {
            publishActiveReviewFile(activeKey, { presented: true, activePath: 'src/workspace.ts' });
            // The list must observe the scroll too, so its unmount flush retains it.
            scroller.scrollTop = 300;
            invokeTestInstanceHandler(screen.findHostByTestId('scm-review-list'), 'onScroll', {
                nativeEvent: { contentOffset: { y: 300 } },
            });
        });
        const { t } = await import('@/text');
        const collapse = screen.findHostByTestId('scm-change-collapse-src_workspace.ts');
        if (!collapse) throw new Error('Missing file collapse button');
        expect(collapse.props.role ?? collapse.props.accessibilityRole).toBe('button');
        expect(collapse.props.accessibilityLabel).toBe(`${t('common.collapse')}: src/workspace.ts`);
        expect(collapse.props['aria-expanded']).toBe(true);
        await act(async () => invokeTestInstanceHandler(collapse, 'onPress'));
        const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
        expect(screen.findByType(DiffFilesListView).props.expandedKeys.has('src/workspace.ts')).toBe(false);
        await screen.pressByTestIdAsync('scm-comparison-view:walkthrough');
        expect(screen.findByTestId('workspace-walkthrough')).not.toBeNull();
        expect(readActiveReviewFile(activeKey)).toMatchObject({ presented: true, activePath: 'src/workspace.ts' });
        const focusBeforeSwitch = readActiveReviewFile(activeKey).focusRequest;
        const detachedScroller = scroller;
        scroller = createViewport();
        await screen.pressByTestIdAsync('scm-comparison-view:files');
        expect(readActiveReviewFile(activeKey).focusRequest).toBe(focusBeforeSwitch);
        const restored = screen.findByType(ChangedFilesReview).props as React.ComponentProps<typeof ChangedFilesReview>;
        expect(restored.initialScrollTop).toBe(300);
        await act(async () => recycler.props.onLoad?.({ elapsedTimeInMs: 0 }));
        await vi.waitFor(() => expect(scroller.scrollTop).toBe(300));
        expect(detachedScroller.scrollTop).toBe(300);
        expect(restored.initialCollapsedPaths).toEqual(['src/workspace.ts']);
        expect(screen.findByType(DiffFilesListView).props.expandedKeys.has('src/workspace.ts')).toBe(false);
        expect(restored.workspaceScope).toEqual({
            serverId: fixture.home.id, machineId: 'm1', rootPath: '/tmp/repo',
        });
        await screen.pressByTestIdAsync('scm-comparison-view:walkthrough');
        expect(requestActiveReviewFile(activeKey, 'src/workspace.ts')).toBe(true);
        const { flushHookEffects } = await import('@/dev/testkit');
        await flushHookEffects({ cycles: 5 });
        expect(screen.findByTestId('workspace-walkthrough')).toBeNull();
        expect(screen.findByType(DiffFilesListView).props.expandedKeys.has('src/workspace.ts')).toBe(true);
        expect(fixture.requests.filter((request) => request.targetId === 's1')).toEqual([]);
    });
    it('reviews the working tree of the Home named by the route, not a same-id match', async () => {
        const routeSnapshot = snapshotWithFile('src/home-b.ts');
        fixture = await createSessionFilesViewFixture({ rootPath: '/tmp/repo', rpc: (request) =>
            request.method === 'scm.status.snapshot' ? { success: true, snapshot: routeSnapshot } : undefined,
        });
        fixture.setSnapshot(routeSnapshot);
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { transferMachine } = await import('../sessionFileTransferTestkit');
        const otherHome = await upsertServerProfile({ serverUrl: 'https://scm-review-other.test' });
        const otherSession = createSessionFixture({
            ...fixture.session, serverId: otherHome.id, updatedAt: fixture.session.updatedAt + 1,
        });
        fixture.storage.setState((state) => ({
            machineListByServerId: { ...state.machineListByServerId, [otherHome.id]: [transferMachine({ id: 'm1', storageMode: 'plain' })] },
        }));
        fixture.storage.getState().applySessions([otherSession]);
        fixture.storage.getState().publishSessionProjectScmSnapshots([{
            sessionId: 's1', serverId: otherHome.id, snapshot: snapshotWithFile('src/home-a.ts'), status: null,
        }]);
        // Both scoped rows exist, while the id-keyed entity holds the other Home.
        const state = fixture.storage.getState();
        expect(state.sessions.s1?.serverId).toBe(otherHome.id);
        expect(state.sessionListRowsByServerId[fixture.home.id]?.s1).toBeTruthy();
        expect(state.sessionListRowsByServerId[otherHome.id]?.s1).toBeTruthy();
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
        const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
        const screen = await fixture.render(<SessionScmReviewDetailsView
            sessionId="s1" serverId={fixture.home.id} scopeId="session:s1"
        />);
        const review = screen.findByType(ChangedFilesReview).props as React.ComponentProps<typeof ChangedFilesReview>;
        expect(review.allRepositoryChangedFiles.map(file => file.fullPath)).toEqual(['src/home-b.ts']);
        expect(review.snapshot).toMatchObject(routeSnapshot);
        expect(fixture.requests.filter(request => request.method === 'scm.status.snapshot')).toEqual([
            expect.objectContaining({ targetId: 'm1', payload: expect.objectContaining({ cwd: '/tmp/repo' }) }),
        ]);
    });

    it('says the Machine is offline with Retry, instead of loading without end, when no snapshot can arrive', async () => {
        fixture = await createSessionFilesViewFixture({ rootPath: '/tmp/repo', rpc: request =>
            request.method === 'scm.status.snapshot' ? new Promise(() => {}) : undefined });
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
        const lastHeartbeat = Date.now();
        // An inactive heartbeat stays reachable during the presence owner's grace: move only the clock.
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(lastHeartbeat + 24 * 60 * 60 * 1000);
            const rows = fixture.storage.getState().machineListByServerId[fixture.scope.serverId] ?? [];
            await act(async () => fixture.storage.getState().applyMachines(rows.map(row => ({ ...row, active: false,
                activeAt: lastHeartbeat, seq: row.seq + 1, updatedAt: Date.now() })), true,
                { sourceServerId: fixture.scope.serverId, sourceAccountId: 'alice' }));
            const screen = await fixture.render(<SessionScmReviewDetailsView sessionId="s1" serverId={fixture.home.id} scopeId="session:s1" />);
            await flushHookEffects({ cycles: 12 });
            expect(screen.findByTestId('session-scm-review-loading')).toBeNull();
            expect(screen.findByTestId('session-scm-review-unreachable')).not.toBeNull();
        } finally { vi.useRealTimers(); }
    });
});
