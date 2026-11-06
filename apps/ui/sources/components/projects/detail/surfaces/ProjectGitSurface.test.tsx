import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { activeReviewFileKeyForWorkspace, readActiveReviewFile, requestActiveReviewFile } from '@/components/workspaces/scm/review/activeReviewFile';
import { ScmLogListResponseSchema } from '@happier-dev/protocol/scm';
import { ScmComparisonCaptureOutputSchema } from '@happier-dev/protocol/scm';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createSessionAccessFixture } from '@/dev/testkit';
import { applyProjectAccountRowsFixture, createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

let reviewCommits = 0;
let reviewData: unknown;
installSessionFilesViewBoundaries({ renderItemLimit: 25, onRecyclerCommit: props => {
    if (props.testID === 'scm-review-list' || props['data-testid'] === 'scm-review-list') {
        reviewCommits += 1;
        reviewData = props.data;
    }
} });
await prepareSessionFilesViewTestkit();
const { ProjectGitSurface } = await import('./ProjectGitSurface');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

describe('Project Changes destination', () => {
    it('does not commit the parked Review when a different file route opens, switches or reopens', async () => {
        const entries = Array.from({ length: 57_000 }, (_, index) => ({ path: `src/file-${index}.ts`,
            previousPath: null, kind: 'modified' as const, includeStatus: '', pendingStatus: 'M',
            hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 1, isBinary: false } }));
        const snapshot = fileViewSnapshot({ rootPath: '/repo', entries });
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request =>
            request.method === 'scm.status.snapshot' ? { success: true, snapshot } : undefined });
        const { DestinationInstanceContext } = await import('@/components/appShell/workspace/destinationInstanceContext');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const noop = () => {};
        const isFocused = () => true;
        const navigation = { push: noop, replace: noop, back: noop };
        reviewCommits = 0;
        let openFile: React.Dispatch<React.SetStateAction<string>>;
        let setPresented: React.Dispatch<React.SetStateAction<boolean>>;
        const surface = <ProjectGitSurface scopeId="project:parked" serverId={fixture.home.id} machineId="m1" rootPath="/repo"
                onOpenFile={noop} onOpenFilePinned={noop} onOpenReviewAllChanges={noop} onOpenStashDetails={noop}
                onOpenCommit={noop} onSelectWorkspacePath={noop} onRequestCreateWorktreeFromAnotherBranch={noop} onRevealInFilesTree={noop} />;
        function Host() {
            const [path, setPath] = React.useState('');
            const [presented, setActive] = React.useState(true);
            openFile = setPath;
            setPresented = setActive;
            const destination = { tabId: 'project:parked', pathname: '/project/parked',
                ref: { kind: 'project', params: { projectId: 'parked', details: 'file', path } },
                focused: true, visible: true, isFocused, navigation };
            return <DestinationInstanceContext.Provider value={destination}>
                <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>{surface}</PluginSurfaceFocusEligibilityProvider>
            </DestinationInstanceContext.Provider>;
        }
        const screen = await fixture.render(<Host />);
        await flushHookEffects({ cycles: 20 });
        const retainedList = screen.findByTestId('scm-review-list');
        expect(retainedList).not.toBeNull();
        await act(async () => setPresented(false));
        await flushHookEffects({ cycles: 10 });
        const baseline = reviewCommits;
        expect(baseline).toBeGreaterThan(0);
        for (const path of ['src/a.ts', 'src/b.ts', 'src/a.ts']) {
            await act(async () => openFile(path));
            await flushHookEffects({ cycles: 5 });
        }
        console.info('57k parked Review: file open/switch/reopen list commits =', reviewCommits - baseline);
        expect(reviewCommits - baseline).toBe(0);
        expect(screen.findByTestId('scm-review-list')).toBe(retainedList);
        const { DiffFilesListView } = await import('@/components/ui/code/diff/DiffFilesListView');
        const heldRows = screen.tree.root.findByType(DiffFilesListView).props.files;
        const heldRecyclerData = reviewData;
        let unseenRowReads = 0;
        const lastHeldRow = heldRows.at(-1)!;
        const lastHeldKey = lastHeldRow.key;
        Object.defineProperty(lastHeldRow, 'key', { configurable: true, get: () => { unseenRowReads += 1; return lastHeldKey; } });
        await act(async () => setPresented(true));
        await flushHookEffects({ cycles: 10 });
        expect(unseenRowReads, 'returning the real Project Review must not scan held rows').toBe(0);
        expect(reviewData, 'returning must not copy the held recycler inventory').toBe(heldRecyclerData);
        expect(screen.tree.root.findByType(DiffFilesListView).props.files).toBe(heldRows);
        expect(screen.findByTestId('scm-review-list')).toBe(retainedList);
        await act(async () => setPresented(false));
        await flushHookEffects({ cycles: 10 });
        await act(async () => fixture.setSnapshot(fileViewSnapshot({ rootPath: '/repo', fetchedAt: 2, entries: entries.slice(0, -1) })));
        await flushHookEffects({ cycles: 10 });
        expect(reviewCommits).toBeGreaterThan(baseline);
        const changed = reviewCommits;
        await act(async () => setPresented(true));
        await flushHookEffects({ cycles: 10 });
        expect(reviewCommits).toBeGreaterThan(changed);
        expect(screen.findByTestId('scm-review-list')).toBe(retainedList);
    });

    it('selects two admitted Session sources on the same checkout and withdraws revoked evidence without a Machine fallback', async () => {
        let admitted = ['s1', 's2'];
        let serverId = '';
        let listRequests = 0;
        const checkout = () => ({ id: 'checkout', serverId, machineId: 'm1', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 });
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', request: async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: { sessions: { filteredListing: { enabled: true } } } }));
            if (path === '/v1/account/project-rows/list') return Response.json(createPlainProjectAccountRowListFixture({ workspaceRefs: serverId ? [checkout()] : [] }));
            if (!['/v2/sessions', '/v1/sessions', '/v2/sessions/query'].includes(path)) return Response.json({}, { status: 404 });
            listRequests += 1;
            return Response.json({ sessions: admitted.map(id => ({ ...V2SessionRecordSchema.parse({
                id, seq: 1, createdAt: 1, updatedAt: 2, active: false, activeAt: 2, latestTurnId: `turn-${id}`,
                encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
                metadata: JSON.stringify({ path: '/repo', machineId: 'm1', projectId: 'anchor', name: `Review ${id}` }),
                metadataVersion: 1, agentState: null, agentStateVersion: 1, share: null,
                effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
                responsibleAccountId: null, responsibleAccount: null,
            }), viewer: {
                latestFailureSeq: null,
                readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                follow: { follows: false, notificationLevel: null }, notification: { level: 'important', source: 'owner' },
            } })), nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
        }, rpc: request => {
            if (request.method === 'scm.status.snapshot') return { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo' }) };
            if (request.method === 'scm.diffSummary.capture') {
                const input = request.payload as { sessionId: string; source: { kind: 'session'; sessionId: string } | { kind: 'turnCheckpoint'; turnId: string } };
                const comparison = { id: `captured-${input.source.kind}-${input.sessionId}`, source: input.source,
                    repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } };
                return ScmComparisonCaptureOutputSchema.parse({ success: true, comparison, metadata: { source: input.source, sourceKey: comparison.id } });
            }
            return undefined;
        } });
        serverId = fixture.home.id;
        // The file-view fixture primes transfer-only features; this flow also admits filtered listing.
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({ features: { sessions: { filteredListing: { enabled: true } } } }) } });
        applyProjectAccountRowsFixture(fixture.storage, { workspaceRefs: [checkout()] });
        const noop = () => {};
        const screen = await fixture.render(<ProjectGitSurface scopeId="project:checkout" serverId={fixture.home.id} machineId="m1" rootPath="/repo"
            onOpenFile={noop} onOpenFilePinned={noop} onOpenReviewAllChanges={noop} onOpenStashDetails={noop}
            onOpenCommit={noop} onSelectWorkspacePath={noop} onRequestCreateWorktreeFromAnotherBranch={noop} onRevealInFilesTree={noop} />);
        await flushHookEffects({ cycles: 20 });
        const picker = () => screen.tree.root.find(node => Array.isArray(node.props.options)
            && typeof node.props.currentLabel === 'string' && typeof node.props.onSelect === 'function');
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(picker().props.options.filter((option: { evidenceSessionId?: string }) => option.evidenceSessionId)
                .map((option: { evidenceSessionId: string }) => option.evidenceSessionId)).toEqual(['s1', 's2']);
        });
        expect(listRequests).toBeGreaterThan(0);
        for (const sessionId of ['s1', 's2']) {
            await act(async () => picker().props.onSelect({ kind: 'session' }, sessionId));
            await flushHookEffects({ cycles: 20 });
            expect(fixture.requests.filter(request => request.method === 'scm.diffSummary.capture').at(-1)).toMatchObject({
                targetId: 'm1', payload: { cwd: '/repo', sessionId, source: { kind: 'session', sessionId } },
            });
        }
        const turn = picker().props.options.find((option: { sourceKind: string; comparison: { turnId?: string } | null }) =>
            option.sourceKind === 'turnCheckpoint' && option.comparison?.turnId === 'turn-s2');
        expect(turn).toMatchObject({ evidenceSessionId: 's2' });
        await act(async () => picker().props.onSelect(turn.comparison, turn.evidenceSessionId));
        await flushHookEffects({ cycles: 20 });
        expect(fixture.requests.filter(request => request.method === 'scm.diffSummary.capture').at(-1)).toMatchObject({
            targetId: 'm1', payload: { cwd: '/repo', sessionId: 's2', source: { kind: 'turnCheckpoint', turnId: 'turn-s2' } },
        });
        admitted = ['s1'];
        const captures = fixture.requests.filter(request => request.method === 'scm.diffSummary.capture').length;
        const { retireSessionListQueryAddress } = await import('@/sync/domains/session/listing/sessionListQueryInvalidation');
        await act(async () => { retireSessionListQueryAddress(fixture.home.id, 's2'); });
        await flushHookEffects({ cycles: 20 });
        expect(picker().props.current).toMatchObject({ kind: 'turnCheckpoint', turnId: 'turn-s2' });
        expect(picker().props.options.some((option: { evidenceSessionId?: string }) => option.evidenceSessionId === 's2')).toBe(false);
        expect(fixture.requests.filter(request => request.method === 'scm.diffSummary.capture')).toHaveLength(captures);
        const { SourceControlUnavailableState } = await import('@/components/workspaces/scm/states/SourceControlUnavailableState');
        expect(screen.findAllByType(SourceControlUnavailableState)).toHaveLength(1);
        expect(screen.findByTestId('scm-comparison-start-review')).toBeNull();
    });
    it('restores the chosen file after Git and page/companion remount without accepting hidden-list scroll requests', async () => {
        const entries = ['src/a.ts', 'src/b.ts'].map((path) => ({ path, previousPath: null, kind: 'modified' as const,
            includeStatus: '', pendingStatus: 'M', hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 1, isBinary: false } }));
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
            if (request.method === 'scm.status.snapshot') return { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo', entries }) };
            if (request.method === 'scm.diff.file') return { success: true, diff: 'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-old\n+new\n' };
            if (request.method === 'scm.log.list') return ScmLogListResponseSchema.parse({ success: true, entries: [] });
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
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
            if (request.method === 'scm.status.snapshot') return { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo' }) };
            if (request.method === 'scm.log.list') return ScmLogListResponseSchema.parse({ success: true, entries: [] });
            return undefined;
        } });
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
