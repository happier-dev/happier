import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';
import { createSessionFileNativeTransferBoundary } from '../sessionFileNativeTransferTestkit';

installSessionFilesViewBoundaries();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let diffVersion = 1;
const diff = (version: number) => 'diff --git a/src/a.txt b/src/a.txt\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-old\n+new-' + version + '\n';
const snapshot = (pendingAdded: number) => fileViewSnapshot({ fetchedAt: pendingAdded ? 1 : 2, entries: [{
    path: 'src/a.txt', kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
    hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
    stats: { pendingAdded, pendingRemoved: 0, includedAdded: 0, includedRemoved: 0, isBinary: false },
}], capabilities: { writeCommitPathSelection: true, writeCommitLineSelection: true } });

beforeAll(prepareSessionFilesViewTestkit);
beforeEach(async () => {
    standardCleanup();
    diffVersion = 1;
    const transfer = createSessionFileNativeTransferBoundary({ bytes: new TextEncoder().encode('file-content'), name: 'a.txt' });
    fixture = await createSessionFilesViewFixture({
        machineCarrierOrigin: 'http://127.0.0.1:48126', request: transfer.request,
        rpc: (request) => {
            if (request.method === 'statFile') return { success: true, exists: true, kind: 'file', sizeBytes: 12 };
            if (request.method === 'scm.diff.file') return { success: true, diff: diff(diffVersion) };
            if (request.method === 'scm.status.snapshot') return { success: true, snapshot: snapshot(1) };
            return transfer.rpc(request);
        },
    });
    fixture.setSnapshot(snapshot(1));
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

describe('SessionFileDetailsView (SCM refresh)', () => {
    it('refreshes diff content in-place when SCM entry fingerprint changes', async () => {
        const { SessionFileDetailsView } = await import('./SessionFileDetailsView');
        const { FileContentPanel } = await import('@/components/workspaces/files/file/FileContentPanel');
        const { FileLoadingState } = await import('@/components/workspaces/files/file/FileScreenState');
        const screen = await fixture.render(<SessionFileDetailsView serverId={fixture.home.id} sessionId="s1" scopeId="session:s1" filePath="src/a.txt" />);
        expect(screen.tree.root.findAllByType(FileContentPanel)).toHaveLength(1);
        expect(screen.tree.root.findByType(FileContentPanel).props.diffContent).toBe(diff(1));
        await act(async () => {
            diffVersion = 2;
            fixture.setSnapshot(snapshot(0));
        });
        await flushHookEffects({ cycles: 20 });
        expect(screen.tree.root.findAllByType(FileContentPanel)).toHaveLength(1);
        expect(screen.tree.root.findByType(FileContentPanel).props.diffContent).toBe(diff(2));
        expect(screen.tree.root.findAllByType(FileLoadingState)).toHaveLength(0);
    });

    it('reacts to active server changes when the session server id is not hydrated yet', async () => {
        const { SessionFileDetailsView } = await import('./SessionFileDetailsView');
        const { WorkspaceFileDetailsView } = await import('@/components/workspaces/files/details/WorkspaceFileDetailsView');
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        fixture.storage.setState({ sessions: { s1: { ...fixture.session, serverId: undefined } },
            sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} });
        const screen = await fixture.render(<SessionFileDetailsView sessionId="s1" scopeId="session:s1" filePath="src/a.txt" />);
        expect(screen.tree.root.findByType(WorkspaceFileDetailsView).props.scope.serverId).toBe(fixture.home.id);
        const secondHome = await upsertServerProfile({ serverUrl: 'https://session-file-views-second.test' });
        await act(async () => {
            await setActiveServer({ serverId: secondHome.id });
            // The focused Home publishes its Machine inventory through the real
            // store, just as Sync does; no fabricated hook subscription is used.
            const machine = fixture.storage.getState().machines.m1!;
            fixture.storage.setState((state) => ({ machineListByServerId: { ...state.machineListByServerId, [secondHome.id]: [machine] } }));
        });
        expect(screen.tree.root.findByType(WorkspaceFileDetailsView).props.scope.serverId).toBe(secondHome.id);
    });
});
