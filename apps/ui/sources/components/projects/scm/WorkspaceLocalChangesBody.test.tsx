import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, standardCleanup } from '@/dev/testkit';
import { ScmCommitComposerCard } from '@/components/workspaces/scm/commitComposer/ScmCommitComposerCard';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
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
    it('keeps manual managed commits usable without offering a controller-only message suggestion', async () => {
        const currentFixture = await createSessionFilesViewFixture({ rootPath: '/repo', settings: { scmCommitMessageGeneratorEnabled: true } });
        fixture = currentFixture;
        const controller = { id: 'controller-checkout', ...currentFixture.scope, createdAtMs: 1 };
        const managed = { v: 2 as const, kind: 'managed' as const, id: 'guest-checkout', serverId: controller.serverId,
            managedId: 'native', controller: { machineId: controller.machineId, installationId: 'installed' },
            rootPath: controller.rootPath, createdAtMs: 1 };
        applyProjectAccountRowsFixture(currentFixture.storage, { workspaceRefs: [controller, managed] });
        const guestScope = { ...currentFixture.scope, workspace: { v: 2 as const, kind: 'managed' as const,
            workspaceId: managed.id, serverId: managed.serverId, managedId: managed.managedId,
            controller: managed.controller, rootPath: managed.rootPath } };
        const snapshot = fileViewSnapshot({ rootPath: '/repo', capabilities: { writeCommit: true }, entries: [{ path: 'a.ts',
            previousPath: null, kind: 'modified', includeStatus: '', pendingStatus: 'M', hasIncludedDelta: false,
            hasPendingDelta: true, stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false } }] });
        currentFixture.storage.getState().updateWorkspaceScmSnapshot(currentFixture.scope, snapshot);
        currentFixture.storage.getState().updateWorkspaceScmSnapshot(guestScope, snapshot);
        const screen = await currentFixture.render(<>
            <WorkspaceLocalChangesBody scope={currentFixture.scope} />
            <WorkspaceLocalChangesBody scope={guestScope} />
        </>);
        const composers = screen.findAllByType(ScmCommitComposerCard);
        expect(composers).toHaveLength(2);
        const suggestion = { accessibilityLabel: t('files.commitMessageEditor.generate') };
        expect(composers[0]!.findAllByProps(suggestion).length).toBeGreaterThan(0);
        expect(composers[1]!.findAllByProps(suggestion)).toHaveLength(0);
        expect(composers[1]!.findAllByProps({ testID: 'scm-commit-message' }).length).toBeGreaterThan(0);
    });
    it.each([true, false])('keeps a retained checkout answer visible through a failed refresh and Retry (isRepo=%s)', async isRepo => {
        const rootPath = `/repo/retained-${isRepo ? 'repository' : 'nonrepo'}`;
        const refresh = createDeferred<unknown>();
        const workspaceWatch = createDeferred<unknown>();
        const recovered = fileViewSnapshot({ rootPath, entries: [{ path: 'src/new.ts', previousPath: null,
            kind: 'modified', includeStatus: '', pendingStatus: 'M', hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false } }] });
        let retrying = false;
        const currentFixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            // The external filesystem watcher stays connected while this test drives snapshot reads.
            if (request.method === 'scm.workspace.watch.v1') return workspaceWatch.promise;
            if (request.method === 'scm.status.snapshot') return retrying ? { success: true, snapshot: recovered } : refresh.promise;
            return undefined;
        } });
        fixture = currentFixture;
        currentFixture.storage.getState().updateWorkspaceScmSnapshot(currentFixture.scope, fileViewSnapshot({ rootPath, isRepo }));
        const screen = await currentFixture.render(<WorkspaceLocalChangesBody scope={currentFixture.scope} />);
        const retainedAnswer = isRepo ? 'workspace-local-changes-clean' : 'workspace-local-changes-not-repo';
        expect(screen.findHostByTestId(retainedAnswer)).not.toBeNull();
        expect(screen.findHostByTestId('workspace-local-changes-stale')).toBeNull();

        await act(async () => { refresh.resolve({ success: false, errorCode: 'BACKEND_UNAVAILABLE', error: 'Snapshot read failed' }); });
        await vi.waitFor(() => expect(currentFixture.storage.getState().getWorkspaceScmSnapshotError(currentFixture.scope))
            .toMatchObject({ errorCode: 'BACKEND_UNAVAILABLE' }));
        await vi.waitFor(() => expect(screen.findHostByTestId('workspace-local-changes-stale')).not.toBeNull());
        expect(screen.findHostByTestId(retainedAnswer)).not.toBeNull();
        expect(screen.findHostByTestId('workspace-local-changes-error')).toBeNull();

        retrying = true;
        await screen.pressByTestIdAsync('workspace-local-changes-stale-action');
        await vi.waitFor(() => expect(screen.findHostByTestId('workspace-local-changes-stale')).toBeNull());
        expect(screen.findHostByTestId(retainedAnswer)).toBeNull();
        expect(screen.findHostByTestId('workspace-local-changes-files')).not.toBeNull();
        expect(currentFixture.storage.getState().getWorkspaceScmSnapshotError(currentFixture.scope)).toBeNull();
    });

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
