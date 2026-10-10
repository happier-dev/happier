import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { invokeTestInstanceHandler, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
beforeAll(prepareSessionFilesViewTestkit);
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

function snapshotWithFile(path: string) {
    return fileViewSnapshot({ rootPath: '/tmp/repo', entries: [{
        path, kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
        hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
        stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
    }], capabilities: { readDiffFile: true, writeCommit: true } });
}

describe('SessionScmReviewDetailsView (exact Home)', () => {
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
            return <WorkspaceScmReviewDetailsView scopeId="project:workspace" workspaceRefId="workspace" workspaceCacheKey="cache"
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
        const snapshot = snapshotWithFile('src/workspace.ts');
        fixture = await createSessionFilesViewFixture({ rootPath: '/tmp/repo', rpc: (request) =>
            request.method === 'scm.status.snapshot' ? { success: true, snapshot } : undefined });
        fixture.setSnapshot(snapshot);
        fixture.storage.setState({ sessions: {} });
        const { WorkspaceScmReviewDetailsView } = await import('@/components/projects/panes/details/views/WorkspaceScmReviewDetailsView');
        const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
        const screen = await fixture.render(<WorkspaceScmReviewDetailsView scopeId="project:workspace-row"
            workspaceRefId="workspace-row" workspaceCacheKey="workspace-cache" machineId="m1"
            rootPath="/tmp/repo" serverId={fixture.home.id} view="files" comparison={{ kind: 'workingTree' }} />);
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
            invokeTestInstanceHandler(screen.findHostByTestId('scm-review-list'), 'onScroll', {
                nativeEvent: { contentOffset: { y: 137 } },
            });
        });
        await screen.pressByTestIdAsync('scm-change-row-src_workspace.ts');
        await screen.pressByTestIdAsync('scm-comparison-view:walkthrough');
        expect(screen.findByTestId('workspace-walkthrough')).not.toBeNull();
        expect(readActiveReviewFile(activeKey)).toMatchObject({ presented: true, activePath: 'src/workspace.ts' });
        await screen.pressByTestIdAsync('scm-comparison-view:files');
        const restored = screen.findByType(ChangedFilesReview).props as React.ComponentProps<typeof ChangedFilesReview>;
        expect(restored.initialScrollTop).toBe(137);
        expect(restored.initialCollapsedPaths).toEqual(['src/workspace.ts']);
        expect(restored.workspaceScope).toEqual({
            serverId: fixture.home.id, machineId: 'm1', rootPath: '/tmp/repo',
        });
        await screen.pressByTestIdAsync('scm-comparison-view:walkthrough');
        expect(requestActiveReviewFile(activeKey, 'src/workspace.ts')).toBe(true);
        const { flushHookEffects } = await import('@/dev/testkit');
        await flushHookEffects({ cycles: 5 });
        expect(screen.findByTestId('workspace-walkthrough')).toBeNull();
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
});
