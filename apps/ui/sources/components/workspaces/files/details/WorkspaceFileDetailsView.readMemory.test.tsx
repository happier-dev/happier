import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { FileFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import { ScmComparisonSchema, ScmWorkingEntrySchema } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

const scrollToIndex = vi.fn();
installSessionFilesViewBoundaries({ platformOS: 'android',
    onRecycler: state => { state.refHandle.scrollToIndex.mockImplementation(scrollToIndex); } });
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { createWorkspaceFileDetailsTab } = await import('@/components/appShell/panes/details/fileDetailsTab');
const { createSessionPaneDetailsTab } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
const { parseSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
const { readProjectFileRouteTarget } = await import('@/components/projects/detail/projectRouteState');
const { readFileTargetAnchorResource } = await import('@/utils/url/sessionFileDeepLink');
const { FileChangesSection } = await import('../file/changes/FileChangesRegions');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
const { FilePageHeader } = await import('../file/FilePageHeader');
const { CodeLinesViewCore } = await import('@/components/ui/code/view/CodeLinesViewCore');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { readWorkspaceFileView } = await import('./workspaceFileDetails/workspaceFileView');
const { selectWorkspaceFilePaneFacts, useWorkspaceFileView } = await import('./workspaceFileDetails/useWorkspaceFileView');
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
let readText = text;
let readGate: Promise<void> | null = null;
let readStarted = false;
let readFails = false;
let liveDiff = turnDiff;
let captureGate: Promise<void> | null = null;
let captureStarted = false;

function FilePane(props: Readonly<{ shown: boolean; seed?: FileFindSeed; anchorLine?: number; changes?: SessionScmReviewComparison; host?: 'session' | 'project'; panel?: boolean }>) {
    // Pane view state is persisted across mounts; the turn journey must not alter the reading-memory fixture.
    const paneScopeId = props.changes ? 'session:original-turn-file' : props.host === 'session' ? `session:${fixture.session.id}` : scopeId;
    pane = useAppPaneScope(paneScopeId);
    React.useEffect(() => { pane.openDetailsTab(props.changes
        ? createSessionPaneDetailsTab({ kind: 'file', path: filePath, changes: props.changes, view: 'changes' })!
        : createWorkspaceFileDetailsTab(filePath), { intent: 'pinned' }); }, []);
    return <KeyboardShortcutProvider handlers={{}}><PluginSurfaceFocusEligibilityProvider active>{props.shown && pane.scopeState?.details.tabs.some(tab => tab.key === tabKey)
        ? <WorkspaceFileDetailsView scopeId={paneScopeId} scope={fixture.scope} filePath={filePath} sessionIdForAugmentation={props.changes || props.host === 'session' ? fixture.session.id : null}
            presentation={props.panel ? 'panel' : 'screen'}
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
    readText = text; readGate = null; readStarted = false; readFails = false; liveDiff = turnDiff;
    captureGate = null; captureStarted = false;
    const read = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-file-views.test',
        serverIdentityId: 'srv_read_memory', accountId: 'alice', machineId: 'm1', tokenEpoch: 0,
        actionId: 'daemon.filesystem.readFile', execute: async () => {
            readStarted = true;
            await readGate;
            if (readFails) return { success: false, error: 'Live file unavailable' };
            return { success: true, content: Buffer.from(readText).toString('base64') };
        } });
    fixture = await createSessionFilesViewFixture({ serverIdentityId: 'srv_read_memory',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        request: async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: read.machine });
            return await read.handle(parsed, init) ?? new Response('{}', { status: 404 });
        },
        rpc: async (request) => {
            if (request.method === RPC_METHODS.SCM_DIFF_FILE) return { success: true, diff: liveDiff };
            if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) {
                captureStarted = true;
                await captureGate;
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
afterEach(async () => { vi.useRealTimers(); standardCleanup(); await fixture?.dispose(); });

it.each(['project', 'session'] as const)('lands the actual %s Search activation route in a retained file viewer', async host => {
    readText = Array.from({ length: 161 }, (_, index) => `export const coast${index} = "Coastal notebook line ${index}";`).join('\n');
    // Captured qa-r330 route shapes; qualifiers are supplied by the real Account fixture.
    const href = host === 'project'
        ? '/projects/c0802341-2759-4aff-833e-5aa44d298042/code?initialFile=review.ts&source=file&anchor=fileLine&startLine=150&activeRootPath=%2Ftmp%2Ffsp-r330-coastal-20261027&fileOpenAs=preview'
        : '/session/cmvr2vxh6007ymcfxyo2selxx?right=files&details=file&path=review.ts&source=file&startLine=150&fileOpenAs=preview#fileLine';
    const { resolveDestinationRefFromHref, resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    const destination = resolveDestinationRefFromHref(resolveCompactAppDestinations({
        builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [],
    }), href)!;
    const target = host === 'project' ? readProjectFileRouteTarget(destination.params) : parseSessionPaneUrlState(destination.params)?.details;
    if (target?.kind !== 'file') throw new Error('Expected the captured Search file route');
    const resource = createSessionPaneDetailsTab(target)!;
    const render = (anchored: boolean) => <PluginSurfaceFocusEligibilityProvider active><KeyboardShortcutProvider handlers={{}}>
        <WorkspaceFileDetailsView scopeId={host === 'project' ? scopeId : `session:${fixture.session.id}`} scope={fixture.scope}
            filePath={target.path} sessionIdForAugmentation={host === 'session' ? fixture.session.id : null}
            deepLinkAnchor={anchored ? readFileTargetAnchorResource(resource.resource) : null} />
    </KeyboardShortcutProvider></PluginSurfaceFocusEligibilityProvider>;
    const screen = await fixture.render(render(false));
    try {
        await vi.waitFor(() => expect(screen.findAllByType(CodeLinesViewCore)).toHaveLength(1));
        scrollToIndex.mockClear();
        await screen.update(fixture.wrap(render(true)));
        await vi.waitFor(() => expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 149 })));
        expect(screen.findByType(CodeLinesViewCore).props.lines[149].renderCodeText).toContain('coast149');
        scrollToIndex.mockClear();
        await screen.update(fixture.wrap(render(true)));
        expect(scrollToIndex).not.toHaveBeenCalled();
    } finally { await screen.unmount(); }
});

it.each(['project', 'session', 'project-same-file'] as const)('addresses Search to the presented Details file on the %s route', async route => {
    const host = route === 'session' ? 'session' : 'project';
    const mainPath = route === 'project-same-file' ? filePath : 'main.ts';
    const page = (shown: boolean) => <PluginSurfaceFocusEligibilityProvider active><KeyboardShortcutProvider handlers={{}}>
        {host === 'project' ? <WorkspaceFileDetailsView scopeId={scopeId} scope={fixture.scope}
            filePath={mainPath} presentation="screen" sessionIdForAugmentation={null} /> : null}
        <FilePane shown={shown} host={host} panel />
    </KeyboardShortcutProvider></PluginSurfaceFocusEligibilityProvider>;
    const screen = await fixture.render(page(true));
    try {
        await vi.waitFor(() => expect(screen.findAllByType(CodeLinesViewCore)).toHaveLength(host === 'project' ? 2 : 1));
        const owner = readActiveFileViewActionOwner();
        expect(owner?.tabId).toBe(tabKey);
        expect(owner?.search?.scope).toMatchObject({ ...fixture.scope, accountId: 'alice' });
        expect(owner?.search?.symbols?.target.path).toBe(filePath);
        expect(owner?.search?.symbols?.getText()).toBe(text);
        if (host === 'project') {
            await act(async () => { pane.closeDetails(); });
            await screen.update(fixture.wrap(page(false)));
            expect(readActiveFileViewActionOwner()?.search?.symbols?.target.path).toBe(mainPath);
        }
    } finally { await screen.unmount(); }
});

it.each(['project', 'session'] as const)('lands a delayed %s path:line beyond the first screen when the file arrives', async (host) => {
    readText = Array.from({ length: 161 }, (_, index) => `line ${index + 1}`).join('\n');
    let releaseRead!: () => void;
    readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const screen = await fixture.render(<FilePane shown host={host} anchorLine={150} />);
    try {
        await vi.waitFor(() => expect(readStarted).toBe(true));
        expect(screen.findAllByType(CodeLinesViewCore)).toHaveLength(0);
        // The external read outlives the existing eight-second highlight hold.
        await act(async () => { vi.advanceTimersByTime(9_000); });
        vi.useRealTimers();
        await act(async () => { releaseRead(); });
        await vi.waitFor(() => expect(screen.findAllByType(CodeLinesViewCore)).toHaveLength(1));
        const landing = screen.findByType(CodeLinesViewCore);
        expect(landing.props.lines).toHaveLength(161);
        expect(landing.props.scrollToLineId).toBe('f:150');
        await vi.waitFor(() => expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 149 })));
        const body = screen.findByType(CodeLinesViewCore);
        expect(body.props.lines[149].newLine).toBe(150);
        // Settled/equivalent renders must not pull the reader back to the route's line.
        scrollToIndex.mockClear();
        await screen.update(fixture.wrap(<FilePane shown host={host} anchorLine={150} />));
        expect(scrollToIndex).not.toHaveBeenCalled();
    } finally { releaseRead(); await screen.unmount(); }
});

it('opens a link-addressed File page (a workspace tab, not a pane tab) on the comparison its link names', async () => {
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({ entries: [ScmWorkingEntrySchema.parse({
        path: filePath, kind: 'modified', includeStatus: ' ', pendingStatus: 'M', hasIncludedDelta: false, hasPendingDelta: true,
        stats: { pendingAdded: 1, pendingRemoved: 1 },
    })] }));
    // A wide workspace tab renders its own Details link's tab without placing it in the pane.
    const destination = parseSessionPaneUrlState({ details: 'file', path: filePath, fileView: 'changes', comparison: 'workingTree' })!.details!;
    expect(destination).toMatchObject({ kind: 'file', changes: { kind: 'workingTree' } });
    const screen = await fixture.render(<KeyboardShortcutProvider handlers={{}}><PluginSurfaceFocusEligibilityProvider active>
        <WorkspaceFileDetailsView scopeId="session:link-addressed-file" scope={fixture.scope} filePath={filePath}
            sessionIdForAugmentation={fixture.session.id} presentation="screen"
            initialView={{ view: 'changes' }} initialChanges={destination.kind === 'file' ? destination.changes : undefined} />
    </PluginSurfaceFocusEligibilityProvider></KeyboardShortcutProvider>);
    try {
        await vi.waitFor(() => expect(screen.findAllByType(FileChangesSection)).toHaveLength(1));
        expect(screen.findByType(FileChangesSection).props.review.changesScope).toEqual({ kind: 'workingTree' });
    } finally { await screen.unmount(); }
});

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

it.each([
    { pinned: false, liveChanged: true },
    { pinned: true, liveChanged: true },
    { pinned: false, liveChanged: false },
])('renders captured checkpoint rows while the live file read stays pending ($pinned/$liveChanged)', async ({ pinned, liveChanged }) => {
    const liveRead = createDeferred<void>();
    readGate = liveRead.promise;
    liveDiff = '';
    if (liveChanged) fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({ entries: [ScmWorkingEntrySchema.parse({
        path: filePath, kind: 'modified', includeStatus: ' ', pendingStatus: 'M', hasIncludedDelta: false, hasPendingDelta: true,
        stats: { pendingAdded: 1, pendingRemoved: 1 },
    })] }));
    const changes: SessionScmReviewComparison = { kind: 'turnCheckpoint', turnId: 'turn-original',
        ...(pinned ? { comparisonId: 'a'.repeat(64) } : {}) };
    const screen = await fixture.render(<FilePane shown changes={changes} />);
    try {
        await vi.waitFor(() => expect(readStarted).toBe(true));
        await vi.waitFor(() => expect(screen.findByType(FilePageHeader).props.menuActions).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'restoreBeforeTurn' }),
        ])));
        await vi.waitFor(() => expect(screen.findAllByType(CodeLinesViewCore)).toHaveLength(1));
        expect(screen.findByType(CodeLinesViewCore).props.lines).toEqual(expect.arrayContaining([
            expect.objectContaining({ renderCodeText: 'after turn' }),
        ]));
        expect(screen.findByType(FileChangesSection).props.review.status).toBe('ready');
        if (pinned) {
            readFails = true;
            await act(async () => { liveRead.resolve(); });
            await vi.waitFor(() => expect(screen.findAllByTestId('file-preview-unavailable-banner').length).toBeGreaterThan(0));
            expect(screen.findByType(FileChangesSection).props.review.status).toBe('ready');
            expect(screen.findAllByType(CodeLinesViewCore)).toHaveLength(1);
        }
        expect(fixture.requests.filter(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE)).toHaveLength(1);
    } finally {
        await screen.unmount();
        liveRead.resolve();
    }
});

it('keeps captured checkpoint content loading until its capture settles', async () => {
    const capture = createDeferred<void>();
    captureGate = capture.promise;
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({ entries: [ScmWorkingEntrySchema.parse({
        path: filePath, kind: 'modified', includeStatus: ' ', pendingStatus: 'M', hasIncludedDelta: false, hasPendingDelta: true,
        stats: { pendingAdded: 1, pendingRemoved: 1 },
    })] }));
    const screen = await fixture.render(<FilePane shown changes={{ kind: 'turnCheckpoint', turnId: 'turn-original' }} />);
    try {
        await vi.waitFor(() => expect(captureStarted).toBe(true));
        await vi.waitFor(() => expect(screen.findByType(FileChangesSection).props.review.status).toBe('loading'));
        await vi.waitFor(() => expect(screen.findAllByTestId('file-changes-loading').length).toBeGreaterThan(0));
        expect(screen.findAllByType(CodeLinesViewCore)).toHaveLength(0);
        await act(async () => { capture.resolve(); });
        await vi.waitFor(() => expect(screen.findAllByType(CodeLinesViewCore)).toHaveLength(1));
        expect(screen.findByType(CodeLinesViewCore).props.lines).toEqual(expect.arrayContaining([
            expect.objectContaining({ renderCodeText: 'after turn' }),
        ]));
    } finally {
        await screen.unmount();
        capture.resolve();
    }
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
        const binding = useAppPaneScope(props.scopeId ?? scopeId, scope => selectWorkspaceFilePaneFacts(scope, `file:${props.path}`));
        patch = useWorkspaceFileView(binding, `file:${props.path}`).patchView;
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

it('does not re-render the File page when pane state it does not read changes', async () => {
    const { useAppPaneContext } = await import('@/components/appShell/panes/AppPaneContext');
    let dispatch!: ReturnType<typeof useAppPaneContext>['dispatch'];
    const noHandlers = {};
    // The host reads the whole scope; its stable child element must not re-render with it.
    function Host(props: Readonly<{ children: React.ReactNode }>) {
        pane = useAppPaneScope(scopeId);
        dispatch = useAppPaneContext(value => ({ dispatch: value.dispatch })).dispatch;
        React.useEffect(() => { pane.openDetailsTab(createWorkspaceFileDetailsTab(filePath), { intent: 'pinned' }); }, []);
        return <KeyboardShortcutProvider handlers={noHandlers}><PluginSurfaceFocusEligibilityProvider active>{props.children}</PluginSurfaceFocusEligibilityProvider></KeyboardShortcutProvider>;
    }
    let commits = 0;
    const page = <React.Profiler id="file-page" onRender={() => { commits += 1; }}>
        <WorkspaceFileDetailsView scopeId={scopeId} scope={fixture.scope} filePath={filePath} sessionIdForAugmentation={null} />
    </React.Profiler>;
    const screen = await fixture.render(<Host>{page}</Host>);
    try {
        await vi.waitFor(() => expect(screen.findAllByType(CodeLinesViewCore)).toHaveLength(1));
        await act(async () => {});
        commits = 0;
        await act(async () => { dispatch({ type: 'openRight', scopeId, tabId: 'git' }); });
        await act(async () => { dispatch({ type: 'openRight', scopeId, tabId: 'files' }); });
        await act(async () => { dispatch({ type: 'setRightTabState', scopeId, tabId: 'files', nextState: { expanded: ['src'] } }); });
        expect(commits).toBe(0);
    } finally { await screen.unmount(); }
});

it('captures the real read owners into tab state and restores both after a pane remount, with explicit requests winning', async () => {
    const screen = await fixture.render(<FilePane shown />);
    try {
        await vi.waitFor(() => expect(screen.findAllByType(CodeLinesViewCore)).toHaveLength(1));
        await act(async () => { screen.findByType(FilePageHeader).props.find.onOpen(); });
        await act(async () => { screen.changeTextByTestId('file-viewer-find.input', 'needle'); });
        const { VirtualizedList } = await import('@/components/ui/lists/virtualized');
        const onViewableItemsChanged = screen.findByType(CodeLinesViewCore).findByType(VirtualizedList).props.onViewableItemsChanged;
        if (!onViewableItemsChanged) throw new Error('Expected the code lines list to observe viewable items');
        const line8 = { index: 7, item: null, key: '7', isViewable: true };
        await act(async () => { onViewableItemsChanged({ viewableItems: [line8], changed: [line8] }); });
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
