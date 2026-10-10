import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { activeReviewFileKeyForWorkspace, readActiveReviewFile, requestActiveReviewFile } from '@/components/workspaces/scm/review/activeReviewFile';

installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { ProjectGitSurface } = await import('./ProjectGitSurface');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

describe('Project Changes destination', () => {
    it('restores the chosen file after Git and page/companion remount without accepting hidden-list scroll requests', async () => {
        const entries = ['src/a.ts', 'src/b.ts'].map((path) => ({ path, previousPath: null, kind: 'modified' as const,
            includeStatus: '', pendingStatus: 'M', hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 1, isBinary: false } }));
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
            if (request.method === 'scm.status.snapshot') return { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo', entries }) };
            if (request.method === 'scm.diff.file') return { success: true, diff: 'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-old\n+new\n' };
            return undefined;
        } });
        fixture.storage.setState({ sessions: {} });
        const noop = () => {};
        let setVisible: React.Dispatch<React.SetStateAction<boolean>>;
        function Host() {
            const [visible, set] = React.useState(true); setVisible = set;
            return visible ? <ProjectGitSurface scopeId="project:retained" serverId={fixture.home.id} machineId="m1" rootPath="/repo"
                onOpenFile={noop} onOpenFilePinned={noop} onOpenReviewAllChanges={noop} onOpenStashDetails={noop}
                onOpenCommit={noop} onSelectWorkspacePath={noop} onRequestCreateWorktreeFromAnotherBranch={noop} onRevealInFilesTree={noop} /> : null;
        }
        const screen = await fixture.render(<Host />);
        const key = activeReviewFileKeyForWorkspace({ serverId: fixture.home.id, machineId: 'm1', rootPath: '/repo' });
        await flushHookEffects({ cycles: 10 });
        await act(async () => { expect(requestActiveReviewFile(key, 'src/b.ts')).toBe(true); });
        await flushHookEffects({ cycles: 10 });
        expect(readActiveReviewFile(key).activePath).toBe('src/b.ts');
        await screen.pressByTestIdAsync('project-changes-mode:git');
        expect(readActiveReviewFile(key).activePath).toBeNull();
        expect(requestActiveReviewFile(key, 'src/a.ts')).toBe(false);
        await screen.pressByTestIdAsync('project-changes-mode:review');
        await flushHookEffects({ cycles: 10 });
        expect(readActiveReviewFile(key).activePath).toBe('src/b.ts');
        await act(async () => setVisible(false));
        await act(async () => setVisible(true));
        await flushHookEffects({ cycles: 10 });
        expect(readActiveReviewFile(key).activePath).toBe('src/b.ts');
    });
    it('opens the shared comparison directly and retains its view across Git and host remount', async () => {
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request =>
            request.method === 'scm.status.snapshot' ? { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo' }) } : undefined });
        fixture.storage.setState({ sessions: {} });
        const noop = () => {};
        const surface = <ProjectGitSurface scopeId="project:wr" serverId={fixture.home.id} machineId="m1" rootPath="/repo"
            onOpenFile={noop} onOpenFilePinned={noop} onOpenReviewAllChanges={noop} onOpenStashDetails={noop}
            onOpenCommit={noop} onSelectWorkspacePath={noop} onRequestCreateWorktreeFromAnotherBranch={noop} onRevealInFilesTree={noop} />;
        let setVisible: React.Dispatch<React.SetStateAction<boolean>>;
        function Host() { const [visible, set] = React.useState(true); setVisible = set; return visible ? surface : null; }
        const screen = await fixture.render(<Host />);
        expect(screen.findByTestId('scm-comparison-view:walkthrough')).not.toBeNull();
        await screen.pressByTestIdAsync('scm-comparison-view:walkthrough');
        expect(screen.findByTestId('workspace-walkthrough')).not.toBeNull();
        await screen.pressByTestIdAsync('project-changes-mode:git');
        expect(screen.findByTestId('workspace-walkthrough')).toBeNull();
        await screen.pressByTestIdAsync('project-changes-mode:review');
        await flushHookEffects({ cycles: 10 });
        expect(screen.findByTestId('workspace-walkthrough')).not.toBeNull();
        await act(async () => setVisible(false));
        await act(async () => setVisible(true));
        await flushHookEffects({ cycles: 10 });
        expect(screen.findByTestId('workspace-walkthrough')).not.toBeNull();
    });
});
