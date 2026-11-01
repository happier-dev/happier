import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// Load the shared runtime graph during collection, outside this file-refresh operation's budget.
await prepareSessionFilesViewTestkit();
const { SessionFileDetailsView } = await import('./SessionFileDetailsView');
beforeEach(async () => {
    standardCleanup();
    diffVersion = 1;
    const transfer = createSessionFileNativeTransferBoundary({ bytes: new TextEncoder().encode('file-content'), name: 'a.txt' });
    fixture = await createSessionFilesViewFixture({
        serverIdentityId: 'srv_scm_refresh',
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
    it('opens a repository-relative captured file under its retained base when the Session cwd is nested', async () => {
        const metadata = fixture.session.metadata;
        if (!metadata) throw new Error('The nested Session fixture must have workspace metadata');
        fixture.storage.getState().applySessions([{ ...fixture.session, metadata: { ...metadata, path: '/repo/nested' } }]);
        const { WorkspaceFileOpenInputSchema } = await import('@happier-dev/protocol/actions/workspaceActionFamily');
        const { buildWorkspaceFileLink, readWorkspaceFileLinkView } = await import('@/utils/url/sessionFileDeepLink');
        const { parseSessionPaneUrlState, createSessionPaneDetailsTab } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
        const { WorkspaceFileDetailsView } = await import('@/components/workspaces/files/details/WorkspaceFileDetailsView');
        const file = WorkspaceFileOpenInputSchema.parse({ target: { kind: 'session', sessionId: fixture.session.id, serverId: fixture.scope.serverId },
            path: 'nested/a.ts', rootPath: '/repo', view: 'view' });
        const url = new URL(buildWorkspaceFileLink(file), 'https://happier.test');
        const target = parseSessionPaneUrlState(Object.fromEntries(url.searchParams))!.details!;
        const tab = createSessionPaneDetailsTab(target)!;
        const view = readWorkspaceFileLinkView(tab.resource);
        const screen = await fixture.render(<SessionFileDetailsView sessionId={fixture.session.id} serverId={fixture.scope.serverId}
            scopeId="session:nested-open" filePath={file.path} initialView={view} />);
        expect(screen.tree.root.findByType(WorkspaceFileDetailsView).props.scope).toMatchObject({ rootPath: '/repo' });
        await vi.waitFor(() => expect(fixture.requests.some(request => request.method === 'daemon.filesystem.readFile')).toBe(true));
        const reads = fixture.requests.filter(request => request.method === 'daemon.filesystem.readFile');
        expect(reads.map(request => request.payload)).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/repo/nested/a.ts' })]));
        expect(JSON.stringify(reads.map(request => request.payload))).not.toContain('/repo/nested/nested/a.ts');
    });

    it('refreshes diff content in-place when SCM entry fingerprint changes', async () => {
        const { WorkspaceFileDetailsView } = await import('@/components/workspaces/files/details/WorkspaceFileDetailsView');
        const { FileContentPanel } = await import('@/components/workspaces/files/file/FileContentPanel');
        const { FileLoadingState } = await import('@/components/workspaces/files/file/FileScreenState');
        // This contract is the live Uncommitted diff. Session-scope Changes uses a captured comparison.
        const screen = await fixture.render(<WorkspaceFileDetailsView scope={fixture.scope} scopeId="project:scm-refresh"
            filePath="src/a.txt" initialView={{ view: 'changes' }} />);
        await vi.waitFor(() => expect(screen.tree.root.findByType(FileContentPanel).props.diffContent).toBe(diff(1)));
        await act(async () => {
            diffVersion = 2;
            fixture.setSnapshot(snapshot(0));
        });
        await flushHookEffects({ cycles: 20 });
        expect(screen.tree.root.findAllByType(FileContentPanel)).toHaveLength(1);
        await vi.waitFor(() => expect(screen.tree.root.findByType(FileContentPanel).props.diffContent).toBe(diff(2)));
        expect(screen.tree.root.findAllByType(FileLoadingState)).toHaveLength(0);
    });

    it('keeps an unknown Session origin unresolved across Home focus changes until it is hydrated', async () => {
        const { SessionFileDetailsView } = await import('./SessionFileDetailsView');
        const { WorkspaceFileDetailsView } = await import('@/components/workspaces/files/details/WorkspaceFileDetailsView');
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        fixture.storage.setState({ sessions: { s1: { ...fixture.session, serverId: undefined } },
            sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} });
        const screen = await fixture.render(<SessionFileDetailsView sessionId="s1" scopeId="session:s1" filePath="src/a.txt" />);
        expect(screen.tree.root.findByType(WorkspaceFileDetailsView).props.scope).toBeNull();
        const secondHome = await upsertServerProfile({ serverUrl: 'https://session-file-views-second.test' });
        await act(async () => {
            await setActiveServer({ serverId: secondHome.id });
            // The focused Home publishes its Machine inventory through the real
            // store, just as Sync does; no fabricated hook subscription is used.
            const machine = fixture.storage.getState().machines.m1!;
            fixture.storage.setState((state) => ({ machineListByServerId: { ...state.machineListByServerId, [secondHome.id]: [machine] } }));
        });
        expect(screen.tree.root.findByType(WorkspaceFileDetailsView).props.scope).toBeNull();
        await act(async () => { fixture.storage.getState().applySessions([fixture.session]); });
        const hydratedScope = screen.tree.root.findByType(WorkspaceFileDetailsView).props.scope;
        expect(hydratedScope).toMatchObject(fixture.scope);
    });
});
