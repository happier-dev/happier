import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { createDeferred, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';
import {
    createSessionFilesViewFixture,
    fileViewSnapshot,
    installSessionFilesViewBoundaries,
    prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { WorkspaceLocalChangesBody } = await import('./WorkspaceLocalChangesBody');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

describe('WorkspaceLocalChangesBody', () => {
    it('keeps changes readable without offering writes when the snapshot has no capability declaration', async () => {
        const snapshot = fileViewSnapshot({ rootPath: '/repo', capabilities: { writeCommit: true }, entries: [{ path: 'src/a.ts', previousPath: null,
            kind: 'modified', includeStatus: '', pendingStatus: 'M', hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false } }] });
        const refresh = createDeferred<unknown>();
        const currentFixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request =>
            request.method === 'scm.status.snapshot' ? refresh.promise : undefined });
        fixture = currentFixture;
        const scope = { serverId: currentFixture.home.id, machineId: 'm1', rootPath: '/repo' };
        currentFixture.storage.getState().updateWorkspaceScmSnapshot(scope, snapshot);
        const screen = await currentFixture.render(<WorkspaceLocalChangesBody
            scope={scope} onOpenReview={() => {}} />);
        expect(screen.findByTestId('scm-commit-message'), screen.getTextContent()).not.toBeNull();
        // The public UI store accepts retained snapshots whose capability projection is absent.
        const retainedSnapshot = { ...snapshot };
        delete retainedSnapshot.capabilities;
        await act(async () => { currentFixture.storage.getState().updateWorkspaceScmSnapshot(scope, retainedSnapshot); });
        expect(screen.findByTestId('workspace-local-changes-files')).not.toBeNull();
        expect(screen.findByTestId('scm-commit-message')).toBeNull();
        await act(async () => { currentFixture.storage.getState().updateWorkspaceScmSnapshot(scope, snapshot); });
        expect(screen.findByTestId('scm-commit-message')).not.toBeNull();
    });

    it('says on the summary row how many files the shared Changes selection includes for commit', async () => {
        const entry = (path: string) => ({ path, previousPath: null, kind: 'modified' as const, includeStatus: '', pendingStatus: 'M',
            hasIncludedDelta: false, hasPendingDelta: true, stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false } });
        const snapshot = fileViewSnapshot({ rootPath: '/repo', capabilities: { writeCommit: true },
            entries: ['src/a.ts', 'src/b.ts', 'src/c.ts'].map(entry) });
        const currentFixture = await createSessionFilesViewFixture({ rootPath: '/repo', settings: { scmCommitStrategy: 'atomic' },
            rpc: request => request.method === 'scm.status.snapshot' ? createDeferred<unknown>().promise : undefined });
        fixture = currentFixture;
        const scope = { serverId: currentFixture.home.id, machineId: 'm1', rootPath: '/repo' };
        currentFixture.storage.getState().updateWorkspaceScmSnapshot(scope, snapshot);
        const screen = await currentFixture.render(<WorkspaceLocalChangesBody scope={scope} onOpenReview={() => {}} />);
        const included = t('projects.localChanges.includedForCommit', { count: 2 });
        expect(screen.findByTestId('workspace-local-changes-files')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain(included);
        // The selection Changes edits is the one the row reads; nothing here keeps its own.
        await act(async () => { currentFixture.storage.getState().markWorkspaceScmCommitSelectionPaths(scope, ['src/a.ts', 'src/c.ts']); });
        expect(screen.getTextContent()).toContain(`${t('projects.localChanges.filesNotCommitted', { count: 3 })} · ${included}`);
        // The commit box says what Commit would commit: the two included files, not all three.
        const summary = (count: number, added: number) => t('files.commitMessageEditor.selectionMeta', { count, added, removed: 0 });
        expect(screen.getTextContent()).toContain(summary(2, 2));
        expect(screen.getTextContent()).not.toContain(summary(3, 3));
    });
});
