import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { FileFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import { ScmComparisonSchema, ScmWorkingEntrySchema } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

installSessionFilesViewBoundaries({ platformOS: 'android' });
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { createWorkspaceFileDetailsTab } = await import('@/components/appShell/panes/details/fileDetailsTab');
const { createSessionPaneDetailsTab } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
const { FileChangesSection } = await import('../file/changes/FileChangesRegions');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
const { FilePageHeader } = await import('../file/FilePageHeader');
const { CodeLinesViewCore } = await import('@/components/ui/code/view/CodeLinesViewCore');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { readWorkspaceFileView } = await import('./workspaceFileDetails/workspaceFileView');
const { useWorkspaceFileView } = await import('./workspaceFileDetails/useWorkspaceFileView');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { readActiveFileViewActionOwner } = await import('@/sync/ops/actions/scopeActionFamily');
const { useRouter } = await import('expo-router');
const filePath = 'source.txt';
const tabKey = `file:${filePath}`;
const scopeId = 'project:read-memory';
const text = Array.from({ length: 24 }, (_, index) => `line ${index + 1} needle`).join('\n');
const turnDiff = 'diff --git a/source.txt b/source.txt\n--- a/source.txt\n+++ b/source.txt\n@@ -1 +1 @@\n-before turn\n+after turn\n';
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let pane: AppPaneScopeApi;
const scrollToIndex = vi.fn();

function FilePane(props: Readonly<{ shown: boolean; seed?: FileFindSeed; anchorLine?: number; changes?: SessionScmReviewComparison }>) {
    // Pane view state is persisted across mounts; the turn journey must not alter the reading-memory fixture.
    const paneScopeId = props.changes ? 'session:original-turn-file' : scopeId;
    pane = useAppPaneScope(paneScopeId);
    React.useEffect(() => { pane.openDetailsTab(props.changes
        ? createSessionPaneDetailsTab({ kind: 'file', path: filePath, changes: props.changes, view: 'changes' })!
        : createWorkspaceFileDetailsTab(filePath), { intent: 'pinned' }); }, []);
    return <KeyboardShortcutProvider handlers={{}}><PluginSurfaceFocusEligibilityProvider active>{props.shown && pane.scopeState?.details.tabs.some(tab => tab.key === tabKey)
        ? <WorkspaceFileDetailsView scopeId={paneScopeId} scope={fixture.scope} filePath={filePath} sessionIdForAugmentation={props.changes ? fixture.session.id : null}
            initialView={props.changes ? { view: 'changes' } : undefined}
            findSeed={props.seed} deepLinkAnchor={props.anchorLine ? { source: 'file', anchor: { kind: 'fileLine', startLine: props.anchorLine } } : null} />
        : null}</PluginSurfaceFocusEligibilityProvider></KeyboardShortcutProvider>;
}

function RetainedProjectFiles(props: Readonly<{ focused: string; definition?: boolean }>) {
    // The canonical Expo boundary supplies navigation; File/pane ownership and destination focus stay real.
    const navigation = useRouter();
    return <KeyboardShortcutProvider handlers={{}}>{['first', 'second'].map(id => {
        const path = id === 'second' && props.definition ? 'retry.ts' : `${id}.ts`;
        return <DestinationInstanceHost key={id} tabId={id}
            ref={{ kind: 'project', params: { workspaceRefId: id, serverId: fixture.scope.serverId } }}
            pathname={`/projects/${id}/code`} navigation={navigation} focused={props.focused === id} visible>
            <WorkspaceFileDetailsView scopeId={`project:${id}`} scope={fixture.scope} filePath={path}
                sessionIdForAugmentation={null} />
        </DestinationInstanceHost>;
    })}</KeyboardShortcutProvider>;
}

beforeEach(async () => {
    standardCleanup(); scrollToIndex.mockClear();
    const read = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-file-views.test',
        serverIdentityId: 'srv_read_memory', accountId: 'alice', machineId: 'm1', tokenEpoch: 0,
        actionId: 'daemon.filesystem.readFile', execute: () => ({ success: true, content: Buffer.from(text).toString('base64') }) });
    fixture = await createSessionFilesViewFixture({ serverIdentityId: 'srv_read_memory',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        request: async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: read.machine });
            return await read.handle(parsed, init) ?? new Response('{}', { status: 404 });
        },
        rpc: (request) => {
            if (request.method === RPC_METHODS.SCM_DIFF_FILE) return { success: true, diff: turnDiff };
            if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) {
                const input = request.payload as { source: import('@happier-dev/protocol/scm').ScmComparisonSource };
                const selected = input.source.kind === 'turnCheckpoint' && input.source.turnId === 'turn-original';
                const comparison = ScmComparisonSchema.parse({ id: 'a'.repeat(64), source: input.source,
                    repository: { rootPath: '/workspace' }, endpoints: {}, inventory: { state: 'complete', reasons: [],
                        files: selected ? [{ path: filePath, changeKind: 'modified', binary: false, generated: false, lockfile: false,
                            evidence: { state: 'available', unifiedDiff: turnDiff }, occurrences: [{
                                id: 'capture:source', alias: 'source', path: filePath, position: 0,
                                before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 },
                            }] }] : [] } });
                return { success: true, comparison, metadata: { sourceKey: comparison.id, source: comparison.source } };
            }
            return { success: true, exists: true, kind: 'file', sizeBytes: Buffer.byteLength(text) };
        } });
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot());
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

it('opens the original turn evidence and restore menu from the real file tab instead of the latest turn', async () => {
    fixture.storage.getState().applySessions([{ ...fixture.session, latestTurnId: 'turn-latest' }]);
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({ entries: [ScmWorkingEntrySchema.parse({
        path: filePath, kind: 'modified', includeStatus: ' ', pendingStatus: 'M', hasIncludedDelta: false, hasPendingDelta: true,
        stats: { pendingAdded: 1, pendingRemoved: 1 },
    })] }));
    const changes = { kind: 'turnCheckpoint' as const, turnId: 'turn-original', checkpointReceiptId: 'receipt-original',
        evidence: 'checkpoint' as const, comparisonId: 'a'.repeat(64) };
    const screen = await fixture.render(<FilePane shown changes={changes} />);
    try {
        await vi.waitFor(() => expect(screen.findByType(FileChangesSection).props.review.status).toBe('ready'));
        const review = screen.findByType(FileChangesSection).props.review;
        expect(review.changesScope).toEqual({ kind: 'turn', turnId: 'turn-original' });
        expect(review.unifiedDiff).toBe(turnDiff);
        expect(review.menuChanges.restoreBeforeTurn).toBeTypeOf('function');
        expect(screen.findByType(FilePageHeader).props.menuActions).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'restoreBeforeTurn' }),
        ]));
        const captures = fixture.requests.filter(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE);
        expect(captures.map(request => request.payload)).toEqual([expect.objectContaining({
            comparisonId: changes.comparisonId,
            source: { kind: 'turnCheckpoint', turnId: 'turn-original', checkpointReceiptId: 'receipt-original', evidenceMode: 'checkpoint' },
        })]);
        await screen.update(fixture.wrap(<FilePane shown changes={changes} />));
        expect(fixture.requests.filter(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE)).toHaveLength(1);
        await act(async () => { pane.patchDetailsTabState(tabKey, { view: { mode: 'diff', changesScope: { kind: 'workingTree' } } }); });
        expect(screen.findByType(FileChangesSection).props.review.changesScope).toEqual({ kind: 'workingTree' });
        expect(screen.findByType(FileChangesSection).props.review.menuChanges.restoreBeforeTurn).toBeUndefined();
        // The explicit scope change does not replay the opener or create another capture.
        expect(fixture.requests.filter(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE)).toHaveLength(1);
        await act(async () => { screen.findByType(FileChangesSection).props.review.selectScope('turn'); });
        await vi.waitFor(() => expect(screen.findByType(FileChangesSection).props.review.status).toBe('ready'));
        expect(screen.findByType(FileChangesSection).props.review.changesScope).toEqual({ kind: 'turn', turnId: 'turn-original' });
        expect(screen.findByType(FileChangesSection).props.review.unifiedDiff).toBe(turnDiff);
        // Returning to the same turn reuses its settled evidence; Retry owns recapture.
        expect(fixture.requests.filter(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE)).toHaveLength(1);
    } finally { await screen.unmount(); }
});

it('publishes only the presented File when another project retains an open File, including definition navigation', async () => {
    const screen = await fixture.render(<RetainedProjectFiles focused="first" />);
    try {
        await vi.waitFor(() => expect(screen.findAllByType(CodeLinesViewCore).length).toBeGreaterThan(0));
        expect(readActiveFileViewActionOwner()).not.toBeNull();
        expect(readActiveFileViewActionOwner()?.search?.symbols?.target.path).toBe('first.ts');
        expect(readActiveFileViewActionOwner()?.search?.symbols?.getText()).toBe(text);
        await screen.update(fixture.wrap(<RetainedProjectFiles focused="second" />));
        await vi.waitFor(() => expect(readActiveFileViewActionOwner()?.search?.symbols?.target.path).toBe('second.ts'));
        await screen.update(fixture.wrap(<RetainedProjectFiles focused="second" definition />));
        await vi.waitFor(() => expect(readActiveFileViewActionOwner()?.search?.symbols?.target.path).toBe('retry.ts'));
        expect(readActiveFileViewActionOwner()?.search?.symbols?.getText()).toBe(text);
    } finally { await screen.unmount(); }
    expect(readActiveFileViewActionOwner()).toBeNull();
});

it.each(['file', 'scope'] as const)('keeps a departing reader patch bound to its original tab when the retained page changes %s', async (change) => {
    let patch!: ReturnType<typeof useWorkspaceFileView>['patchView'];
    let originalPane!: AppPaneScopeApi;
    function Binding(props: Readonly<{ path: string; scopeId?: string }>) {
        pane = useAppPaneScope(props.scopeId ?? scopeId);
        const first = useAppPaneScope(scopeId);
        originalPane = first;
        patch = useWorkspaceFileView(pane, `file:${props.path}`).patchView;
        React.useEffect(() => { pane.openDetailsTab(createWorkspaceFileDetailsTab(props.path), { intent: 'pinned' }); }, [props.path, props.scopeId]);
        return null;
    }
    const screen = await fixture.render(<Binding path={filePath} />);
    try {
        const departing = patch;
        await screen.update(fixture.wrap(<Binding path={change === 'file' ? 'other.txt' : filePath} scopeId={change === 'scope' ? 'project:other' : scopeId} />));
        await act(async () => { departing({ findQuery: 'original tab' }); });
        expect(readWorkspaceFileView(originalPane.scopeState?.details.tabState[tabKey]).findQuery).toBe('original tab');
        expect(readWorkspaceFileView(pane.scopeState?.details.tabState[change === 'file' ? 'file:other.txt' : tabKey]).findQuery).toBeUndefined();
    } finally { await screen.unmount(); }
});

it('captures the real read owners into tab state and restores both after a pane remount, with explicit requests winning', async () => {
    const screen = await fixture.render(<FilePane shown />, { createNodeMock: element => Array.isArray(element.props.data) ? { scrollToIndex } : null });
    try {
        await vi.waitFor(() => expect(screen.findAllByType(CodeLinesViewCore)).toHaveLength(1));
        await act(async () => { screen.findByType(FilePageHeader).props.find.onOpen(); });
        await act(async () => { screen.changeTextByTestId('file-viewer-find.input', 'needle'); });
        await act(async () => { screen.findByType(CodeLinesViewCore).findByType('FlatList').props.onViewableItemsChanged({ viewableItems: [{ index: 7 }] }); });
        await screen.update(fixture.wrap(<FilePane shown={false} />));
        expect(readWorkspaceFileView(pane.scopeState?.details.tabState[tabKey])).toMatchObject({ scrollLine: 8, findQuery: 'needle', findOpen: true });

        scrollToIndex.mockClear();
        await screen.update(fixture.wrap(<FilePane shown />));
        await vi.waitFor(() => expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 7, viewPosition: 0, animated: false })));
        // A rebuilt page (a resize between the desktop pane and the phone page) keeps Find open with its query.
        expect(screen.findByTestId('file-viewer-find.input')?.props.value).toBe('needle');

        await screen.update(fixture.wrap(<FilePane shown={false} />));
        scrollToIndex.mockClear();
        const seed: FileFindSeed = { query: 'line 12', options: { matchCase: false, regex: false },
            target: { kind: 'file', path: filePath, anchor: { kind: 'fileLine', startLine: 12 } } };
        await screen.update(fixture.wrap(<FilePane shown seed={seed} anchorLine={18} />));
        await vi.waitFor(() => expect(screen.findByTestId('file-viewer-find.input')?.props.value).toBe('line 12'));
        await vi.waitFor(() => expect(scrollToIndex).toHaveBeenLastCalledWith(expect.objectContaining({ index: 11 })));
        expect(scrollToIndex.mock.calls.some(([target]) => target.index === 7)).toBe(false);
    } finally { await screen.unmount(); }
});
