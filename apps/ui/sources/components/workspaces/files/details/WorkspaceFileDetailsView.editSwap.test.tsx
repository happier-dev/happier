// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToolCallMessageFixture, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createSessionFileNativeTransferBoundary } from '@/components/sessions/files/sessionFileNativeTransferTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { ScmWorkingEntrySchema } from '@happier-dev/protocol/scm/workingSnapshot';
import { ScmComparisonSchema, type ScmComparison } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { resolveHref } from 'expo-router/build/link/href';
import type { DestinationNavigation } from '@/components/appShell/workspace/destinationInstanceContext';

const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_text: string) => true) }));
const viewport = vi.hoisted(() => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }));
vi.mock('expo-clipboard', () => clipboard);
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() }).module;
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const { createCapturingFlatListMock } = await import('@/dev/testkit/mocks/virtualizedList');
    // The host renderer has no measured RN list viewport; real File code rows still render.
    return createReactNativeWebMock({ ...createCapturingFlatListMock({ renderItems: true }).module,
        Dimensions: { get: () => viewport } });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

const filePath = 'src/retry.ts';
const svg = 'export const attempts = 3;\nexport function retryLabel(): string { return `Retry ${attempts}`; }\n';
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
let actionRequests: string[];
let readInputs: unknown[];
let scmDiff = '';
let capturedComparison: ScmComparison | null = null;
let portalBoundary: ReturnType<typeof installReactDomPortalBoundaryForTests>;
let restoreEngineLoader: () => void;
// Compile and load the real runtime graph during collection, as the other composed File tests do.
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { ModalProvider } = await import('@/modal');
const { SelectionToolbar } = await import('@/components/ui/code/selection/SelectionToolbar');
const { ReviewCommentInlineComposer } = await import('@/components/ui/code/reviewComments/ReviewCommentInlineComposer');
const { HunkContextMenu } = await import('@/components/ui/code/diff/hunks/HunkContextMenu');
const { DiffViewer } = await import('@/components/ui/code/diff/DiffViewer');
beforeEach(async () => {
    standardCleanup();
    const previousRequire = window.require;
    const previousMonaco = window.monaco;
    // The renderer cannot execute AMD assets. Model a genuinely pending engine,
    // rather than depending on a prior fixture's loader timeout or failed script.
    window.monaco = undefined;
    window.require = Object.assign((_dependencies: unknown) => {}, { config: () => {} });
    restoreEngineLoader = () => { window.require = previousRequire; window.monaco = previousMonaco; };
    viewport.width = 1440;
    clipboard.setStringAsync.mockClear();
    // jsdom supplies the web modal DOM; Node supplies real, fetchable Blob URLs.
    vi.stubGlobal('Blob', getVitestNodeBuiltin<typeof import('node:buffer')>('node:buffer').Blob);
    vi.stubGlobal('URL', getVitestNodeBuiltin<typeof import('node:url')>('node:url').URL);
    portalBoundary = installReactDomPortalBoundaryForTests();
    actionRequests = [];
    readInputs = [];
    scmDiff = '';
    capturedComparison = null;
    transfer = createSessionFileNativeTransferBoundary({ bytes: new TextEncoder().encode(svg), name: filePath });
    const read = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-file-views.test',
        serverIdentityId: 'srv_edit_swap', accountId: 'alice', machineId: 'm1', tokenEpoch: 0,
        actionId: 'daemon.filesystem.readFile', execute: input => {
            readInputs.push(input);
            return transfer.rpc({ targetId: 'm1',
                method: getActionSpec('daemon.filesystem.readFile').bindings!.rpcMethod!, payload: input });
        } });
    fixture = await createSessionFilesViewFixture({ serverIdentityId: 'srv_edit_swap', machineCarrierOrigin: transfer.origin,
        // Private requester admission needs current Account provenance, not the legacy Home token default.
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        request: async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname.startsWith('/v1/actions/')) actionRequests.push(parsed.pathname);
            if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: read.machine });
            return await read.handle(parsed, init) ?? transfer.request(url, init);
        },
        rpc: request => request.method === 'scm.diff.file' ? { success: true, diff: scmDiff }
            : request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE && capturedComparison ? { success: true, comparison: capturedComparison,
                metadata: { sourceKey: capturedComparison.id, source: capturedComparison.source } }
            : transfer.rpc(request) });
    // Each transport fixture reuses one workspace identity with different disk diffs.
    const { invalidateWorkspaceUnifiedDiffPath } = await import('@/scm/diff/fetchWorkspaceUnifiedDiffForPath');
    invalidateWorkspaceUnifiedDiffPath({ scope: fixture.scope, path: filePath });
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot());
    // This page edits: the editor feature is on (the shared fixture leaves it off for read-only pages).
    fixture.storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'scm.writeOperations': true, 'files.reviewComments': false,
        'files.diffSyntaxHighlighting': false, 'files.editor': true } });
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); portalBoundary?.restore(); restoreEngineLoader?.(); vi.unstubAllGlobals(); });

describe('File page View → Edit swap', () => {
    it.each(['session', 'project'] as const)('hands a cold %s edit launch seed to the native editor while its engine is warming', async host => {
        const { FileEditorPanel } = await import('../file/editor/FileEditorPanel');
        const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { FindBar } = await import('@/components/ui/find/FindBar');
        let consumed = 0;
        function SeededEditor() {
            const [seed, setSeed] = React.useState<import('@/components/appShell/panes/fileFindSeedHandoff').FileFindSeed | null>({
                query: 'retryLabel', options: { matchCase: true, regex: false },
                target: { kind: 'file', path: filePath, anchor: { kind: 'fileLine', startLine: 2 } },
            });
            return <KeyboardShortcutProvider handlers={{}}><PluginSurfaceFocusEligibilityProvider active>
                <WorkspaceFileDetailsView scopeId={`${host}:native-find-launch`} scope={fixture.scope} filePath={filePath}
                    sessionIdForAugmentation={host === 'session' ? fixture.session.id : null} initialView={{ view: 'edit' }}
                    findSeed={seed} onFindSeedConsumed={() => { consumed++; setSeed(null); }} />
            </PluginSurfaceFocusEligibilityProvider></KeyboardShortcutProvider>;
        }
        const screen = await fixture.render(<SeededEditor />);
        try {
            await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
            await flushHookEffects();
            expect(screen.findByType(FileEditorPanel).props.editorRef.current?.find?.getSnapshot()).toMatchObject({
                query: 'retryLabel', options: { matchCase: true, regex: false },
            });
            expect(consumed).toBe(1);
            // The read view remains painted during boot, but native Find owns the launch.
            expect(screen.findAllByType(FindBar)).toHaveLength(0);
        } finally { await screen.unmount(); }
    });

    it('carries the reader\'s open Find into the editor\'s own Find on Edit, at the current match', async () => {
        const { FileEditorPanel } = await import('../file/editor/FileEditorPanel');
        const { FilePageHeader } = await import('../file/FilePageHeader');
        const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { FindBar } = await import('@/components/ui/find/FindBar');
        let rendered: Awaited<ReturnType<typeof fixture.render>> | undefined;
        let handedSeed: import('@/components/appShell/panes/fileFindSeedHandoff').FileFindSeed | null = null;
        const observeHandoff = () => {
            const panel = rendered?.findAllByType(FileEditorPanel)[0];
            if (panel?.props.findSeed) handedSeed = panel.props.findSeed;
        };
        function ReadingWithFind() {
            const [seed, setSeed] = React.useState<import('@/components/appShell/panes/fileFindSeedHandoff').FileFindSeed | null>({
                query: 'retryLabel', options: { matchCase: false, regex: false }, target: { kind: 'file', path: filePath },
            });
            return <React.Profiler id="edit-find-handoff" onRender={observeHandoff}><ModalProvider><KeyboardShortcutProvider handlers={{}}><PluginSurfaceFocusEligibilityProvider active>
                <WorkspaceFileDetailsView scopeId="project:find-into-edit" scope={fixture.scope} filePath={filePath}
                    sessionIdForAugmentation={null} findSeed={seed} onFindSeedConsumed={() => setSeed(null)} />
            </PluginSurfaceFocusEligibilityProvider></KeyboardShortcutProvider></ModalProvider></React.Profiler>;
        }
        const screen = await fixture.render(<ReadingWithFind />);
        rendered = screen;
        try {
            // The reader's Find is open on the query, its one match on line 2.
            await vi.waitFor(() => expect(screen.findAllByType(FindBar).map((bar) => bar.props.query)).toEqual(['retryLabel']));
            await vi.waitFor(() => expect(screen.findByType(FilePageHeader).props.edit?.kind).toBe('edit'));
            await act(async () => { screen.findByType(FilePageHeader).props.edit.onPress(); });
            await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
            await flushHookEffects({ cycles: 4 });
            expect(handedSeed).toMatchObject({ query: 'retryLabel', target: { path: filePath,
                anchor: { kind: 'fileLine', startLine: 2 } } });
            // The editor's own Find takes the query over at that match; nothing else keeps a second copy.
            expect(screen.findByType(FileEditorPanel).props.editorRef.current?.find?.getSnapshot()).toMatchObject({
                query: 'retryLabel', options: { matchCase: false, regex: false },
            });
        } finally { await screen.unmount(); }
    });

    it.each(['view', 'changes'] as const)('reveals a changed same-file navigation anchor after %s → Edit without replacing its editor', async origin => {
        const { FilePageHeader } = await import('../file/FilePageHeader');
        const { FileEditorPanel } = await import('../file/editor/FileEditorPanel');
        const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
        const { createWorkspaceActionAdapter } = await import('@/components/appShell/workspace/workspaceActions');
        const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
        const { createWorkspaceState, reduceWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
        const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { readFileTargetAnchorResource, readWorkspaceFileLinkView } = await import('@/utils/url/sessionFileDeepLink');
        const text = Array.from({ length: 56 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join('\n');
        transfer = createSessionFileNativeTransferBoundary({ bytes: new TextEncoder().encode(text), name: filePath });
        scmDiff = `--- a/${filePath}\n+++ b/${filePath}\n@@ -0,0 +1,56 @@\n${text.split('\n').map(line => `+${line}`).join('\n')}\n`;
        fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({ entries: [
            ScmWorkingEntrySchema.parse({ path: filePath, kind: 'untracked', includeStatus: ' ', pendingStatus: '?', hasPendingDelta: true }),
        ] }));
        const params = { workspaceRefId: 'editor-navigation', serverId: fixture.scope.serverId,
            initialFile: filePath, source: 'file', anchor: 'fileLine', startLine: '52' };
        // QA retained an older Code destination before opening Changes in another tab.
        // Both address the same Project; navigation must keep the originating editor.
        let state = createWorkspaceState({ id: origin === 'changes' ? 'older-code' : 'editing', pinned: false, preview: false,
            target: { kind: 'project', params: { ...params, pageId: 'code' } } });
        if (origin === 'changes') state = reduceWorkspaceState(state, { type: 'openTab', groupId: state.focusedGroupId,
            tab: { id: 'editing', pinned: false, preview: false,
                target: { kind: 'project', params: { ...params, pageId: 'changes', fileView: 'changes' } } } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
            dispatch: action => { state = reduceWorkspaceState(state, action); },
            // Browser URL writes are the external boundary; admission and File state remain real.
            transport: { commit: () => {} }, createId: () => 'new-tab', onChange: () => {} });
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null, createId: () => 'new-tab' });
        const destinationNavigation: DestinationNavigation = {
            push: href => { navigation.openHref(resolveHref(href), { tabId: 'editing' }); },
            replace: href => { navigation.openHref(resolveHref(href), { tabId: 'editing', replace: true }); },
            back: () => navigation.step(-1),
        };
        const render = () => {
            const target = state.tabs.editing.target;
            return <KeyboardShortcutProvider handlers={{}}><DestinationInstanceHost tabId="editing" ref={target}
                pathname={`/projects/editor-navigation/${target.params.pageId}`} visible
                navigation={destinationNavigation}
                focused={state.groups[state.focusedGroupId].activeTabId === 'editing'}>
                <WorkspaceFileDetailsView scopeId={`project:editor-navigation:${origin}`} scope={fixture.scope} filePath={filePath}
                    initialView={readWorkspaceFileLinkView(target.params)} sessionIdForAugmentation={null}
                    deepLinkAnchor={readFileTargetAnchorResource({ path: filePath, anchor: { kind: 'fileLine', startLine: Number(target.params.startLine) } })} />
            </DestinationInstanceHost></KeyboardShortcutProvider>;
        };
        const openLine = async (line: number) => {
            expect(execute('workspace.tabs.open', { file: { target: { kind: 'project', workspaceRefId: 'editor-navigation',
                ...fixture.scope }, path: filePath, anchor: { kind: 'fileLine', startLine: line } }, mode: 'preview' })).toEqual({ ok: true });
            await screen.update(fixture.wrap(render()));
            expect(state.groups[state.focusedGroupId].activeTabId).toBe('editing');
        };
        const screen = await fixture.render(render());
        try {
            await vi.waitFor(() => {
                expect(screen.findByType(FilePageHeader).props.edit?.kind).toBe('edit');
                expect(screen.findByType(FilePageHeader).props.displayMode).toBe(origin === 'changes' ? 'diff' : 'file');
            });
            await act(async () => { screen.findByType(FilePageHeader).props.edit.onPress(); });
            await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
            const editor = screen.findByType(FileEditorPanel);
            const handle = editor.props.editorRef.current;
            const reveal = vi.spyOn(handle, 'revealLine');
            await act(async () => { editor.props.onReady(); });
            reveal.mockClear();
            const resetKey = editor.props.resetKey;
            await openLine(18);
            await vi.waitFor(() => expect(reveal).toHaveBeenCalledWith(18, expect.objectContaining({ focus: true })));
            expect(screen.findByType(FileEditorPanel).props.editorRef.current).toBe(handle);
            expect(screen.findByType(FileEditorPanel).props.resetKey).toBe(resetKey);
            expect(handle.getValue()).toBe(text);
            reveal.mockClear();
            await screen.update(fixture.wrap(render()));
            expect(reveal).not.toHaveBeenCalled();
            await openLine(52);
            await vi.waitFor(() => expect(reveal).toHaveBeenCalledWith(52, expect.objectContaining({ focus: true })));
        } finally { await screen.unmount(); }
    });

    it.each(['file', 'diff', 'edit'] as const)('follows an agent write in %s, pauses on a browser wheel, and resumes to the same region', async mode => {
        const { createReducer } = await import('@happier-dev/session-core/reducer');
        const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
        const { createWorkspaceFileDetailsTab } = await import('@/components/appShell/panes/details/fileDetailsTab');
        const { useSessionTrack, TrackInputBoundary, TrackCapsule } = await import('@/components/sessions/files/track/SessionTrack');
        const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { FilePageHeader } = await import('../file/FilePageHeader');
        const { FileEditorPanel } = await import('../file/editor/FileEditorPanel');
        const { paneUiState } = await import('@/sync/domains/state/filePaneUiState');
        const { replacePersistentUiStateForTest } = await import('@/dev/testkit/harness/persistentUiState');
        const originalPanes = paneUiState.readAll();
        const content = Array.from({ length: 120 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join('\n');
        transfer = createSessionFileNativeTransferBoundary({ bytes: new TextEncoder().encode(content), name: filePath });
        scmDiff = `--- a/${filePath}\n+++ b/${filePath}\n@@ -0,0 +1,120 @@\n${content.split('\n').map(line => `+${line}`).join('\n')}\n`;
        fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({ entries: [
            ScmWorkingEntrySchema.parse({ path: filePath, kind: 'untracked', includeStatus: ' ', pendingStatus: '?', hasPendingDelta: true }),
        ] }));
        fixture.storage.setState({ localSettings: { ...fixture.storage.getState().localSettings, filesTrackAgentEdits: false } });
        const root = document.createElement('div');
        document.body.append(root);
        const landings: number[] = [];
        let track!: ReturnType<typeof useSessionTrack>;
        let pane!: ReturnType<typeof useAppPaneScope>;
        const scopeId = `session:track-follow-${mode}`;
        function Scene() {
            pane = useAppPaneScope(scopeId);
            track = useSessionTrack({ scopeId, sessionAddress: { serverId: fixture.scope.serverId, sessionId: fixture.session.id },
                workspaceRoot: fixture.scope.rootPath, active: true });
            return <TrackInputBoundary track={track}><TrackCapsule track={track} />
                <WorkspaceFileDetailsView scopeId={scopeId} scope={fixture.scope} filePath={filePath}
                    sessionIdForAugmentation={null} />
            </TrackInputBoundary>;
        }
        const screen = await fixture.render(<ModalProvider><KeyboardShortcutProvider handlers={{}}>
            <PluginSurfaceFocusEligibilityProvider active><Scene /></PluginSurfaceFocusEligibilityProvider>
        </KeyboardShortcutProvider></ModalProvider>, { createNodeMock: node => {
            if (typeof node.props.nativeID === 'string') {
                const row = document.createElement('div'); row.id = node.props.nativeID;
                const dataSet = node.props.dataSet;
                const newLine = typeof dataSet === 'object' && dataSet !== null && 'codeLineNew' in dataSet
                    ? Number(dataSet.codeLineNew) : NaN;
                row.scrollIntoView = () => { landings.push(newLine); row.dispatchEvent(new Event('scroll', { bubbles: true })); };
                root.append(row);
                return row;
            }
            return node.type === 'View' ? root : null;
        } });
        try {
            await act(async () => { pane.openDetailsTab(createWorkspaceFileDetailsTab(filePath), { intent: 'pinned' }); });
            await vi.waitFor(() => expect(screen.findByType(FilePageHeader).props.edit?.kind).toBe('edit'));
            if (mode === 'edit') await act(async () => { screen.findByType(FilePageHeader).props.edit.onPress(); });
            else await act(async () => { screen.findByType(FilePageHeader).props.onDisplayMode(mode); });
            let editorReveal: ReturnType<typeof vi.spyOn> | undefined;
            if (mode === 'edit') {
                await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
                // The embedded editor is an external engine boundary. Its pending handle is real;
                // observe its reveal command while AMD remains pending in this host renderer.
                const handle = screen.findByType(FileEditorPanel).props.editorRef.current;
                editorReveal = vi.spyOn(handle, 'revealLine');
                await act(async () => { screen.findByType(FileEditorPanel).props.onReady(); });
                editorReveal.mockClear();
            }
            const message = createToolCallMessageFixture({ id: 'track-write', tool: { id: 'track-write', name: 'Edit',
                input: { file_path: filePath, old_string: 'export const line89 = 89;', new_string: 'export const line89 = 890;' },
                state: 'running', createdAt: 1, startedAt: 2, completedAt: null, description: null } });
            await act(async () => {
                fixture.storage.getState().applySessions([{ ...fixture.session, thinking: true, thinkingAt: Date.now(), latestTurnStatus: 'in_progress' }]);
                fixture.storage.setState({ localSettings: { ...fixture.storage.getState().localSettings, filesTrackAgentEdits: true },
                    sessionMessages: { [fixture.session.id]: { messageIdsOldestFirst: [message.id], messagesById: { [message.id]: message },
                        messagesMap: { [message.id]: message }, reducerState: createReducer(), messagesVersion: 1, isLoaded: true,
                        latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null } } });
            });
            if (mode === 'edit') await vi.waitFor(() => expect(editorReveal).toHaveBeenCalledWith(89, expect.objectContaining({ focus: false })));
            else await vi.waitFor(() => expect(landings).toContain(89));
            expect(track.paused).toBe(false);
            const before = mode === 'edit' ? editorReveal!.mock.calls.length : landings.length;
            await act(async () => { root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 50 })); });
            expect(track.paused).toBe(true);
            await act(async () => { track.resume(); });
            await vi.waitFor(() => expect(mode === 'edit' ? editorReveal!.mock.calls.length : landings.length).toBeGreaterThan(before));
            expect(track.paused).toBe(false);
        } finally {
            await screen.unmount(); root.remove(); replacePersistentUiStateForTest(paneUiState, originalPanes);
        }
    });

    it.each([1440, 390])('keeps one unsaved buffer through Changes and View at width %s', async (width) => {
        viewport.width = width;
        const { FilePageHeader } = await import('../file/FilePageHeader');
        const { FileEditorPanel } = await import('../file/editor/FileEditorPanel');
        const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
        const { SessionCockpitBottomChromeHeightContext } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
        scmDiff = '--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-export const attempts = 2;\n+export const attempts = 3;\n';
        fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({ entries: [
            ScmWorkingEntrySchema.parse({ path: filePath, kind: 'modified', includeStatus: ' ', pendingStatus: 'M', hasPendingDelta: true }),
        ] }));
        const screen = await fixture.render(<ModalProvider><SessionCockpitBottomChromeHeightContext.Provider value={width === 390 ? 84 : 0}>
            <SurfaceStateSizeProvider size={width === 390 ? 'phone' : 'page'}>
                <WorkspaceFileDetailsView scopeId={`project:buffer-${width}`} scope={fixture.scope} filePath={filePath}
                    sessionIdForAugmentation={null} />
            </SurfaceStateSizeProvider>
        </SessionCockpitBottomChromeHeightContext.Provider></ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.findByType(FilePageHeader).props.edit?.kind).toBe('edit'));
            await act(async () => { screen.findByType(FilePageHeader).props.edit.onPress(); });
            await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
            const draft = svg.replace('attempts = 3', 'attempts = 19');
            await act(async () => { screen.findByType(FileEditorPanel).props.onChange(draft); });
            for (const mode of ['diff', 'file'] as const) {
                await act(async () => { await screen.findByType(FilePageHeader).props.onDisplayMode(mode); });
                await flushHookEffects();
                await act(async () => { screen.findByType(FilePageHeader).props.onStartEditingFile(); });
                await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
                expect(screen.findByType(FileEditorPanel).props.value).toBe(draft);
                const handle = screen.findByType(FileEditorPanel).props.editorRef.current;
                if (width === 390) await screen.pressByTestIdAsync('code-editor-accessory-undo');
                else await act(async () => { handle.runCommand('undo'); });
                expect(handle.getValue()).toBe(svg);
                await act(async () => { handle.runCommand('redo'); });
                expect(handle.getValue()).toBe(draft);
            }
        } finally { await screen.unmount(); }
    });

    it('stops saying "No changes" once the buffer is unsaved (QA-PROJECTS D7)', async () => {
        const { FilePageHeader } = await import('../file/FilePageHeader');
        const { FileEditorPanel } = await import('../file/editor/FileEditorPanel');
        const { t } = await import('@/text');
        fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({ entries: [] }));
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:no-changes-dirty" scope={fixture.scope} filePath={filePath} sessionIdForAugmentation={null} />
        </ModalProvider>);
        try {
            const facts = () => (screen.findByType(FilePageHeader).props.summaryFacts ?? []) as readonly string[];
            await vi.waitFor(() => expect(facts()).toContain(t('detailsSurface.file.noChanges')));
            await act(async () => { screen.findByType(FilePageHeader).props.edit.onPress(); });
            await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
            await act(async () => { screen.findByType(FileEditorPanel).props.onChange(`${svg}\nedited`); });
            await vi.waitFor(() => expect(facts()).not.toContain(t('detailsSurface.file.noChanges')));
        } finally { await screen.unmount(); }
    });

    it('restores a clean retained Edit selection after the File scene remounts', async () => {
        const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
        const { createWorkspaceFileDetailsTab } = await import('@/components/appShell/panes/details/fileDetailsTab');
        const { FilePageHeader } = await import('../file/FilePageHeader');
        const { FileEditorPanel } = await import('../file/editor/FileEditorPanel');
        const { readWorkspaceFileView } = await import('./workspaceFileDetails/workspaceFileView');
        let pane!: ReturnType<typeof useAppPaneScope>;
        let show!: React.Dispatch<React.SetStateAction<boolean>>;
        function Scene() {
            pane = useAppPaneScope('session:clean-edit-return');
            const [visible, setVisible] = React.useState(true);
            show = setVisible;
            return visible ? <WorkspaceFileDetailsView scopeId={pane.scopeId} scope={fixture.scope} filePath={filePath}
                sessionIdForAugmentation={fixture.session.id} /> : null;
        }
        const screen = await fixture.render(<ModalProvider><Scene /></ModalProvider>);
        try {
            await act(async () => { pane.openDetailsTab(createWorkspaceFileDetailsTab(filePath), { intent: 'pinned' }); });
            await vi.waitFor(() => expect(screen.findByType(FilePageHeader).props.edit?.kind).toBe('edit'));
            await act(async () => { screen.findByType(FilePageHeader).props.edit.onPress(); });
            await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
            expect(readWorkspaceFileView(pane.scopeState?.details.tabState[`file:${filePath}`]).mode).toBe('edit');
            await act(async () => { show(false); });
            await act(async () => { show(true); });
            await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
            expect(screen.findByType(FileEditorPanel).props.value).toBe(svg);
            // Explicit Done chooses View; returning must not reopen an editor the person closed.
            await act(async () => { await screen.findByType(FilePageHeader).props.editor.onDone(); });
            expect(screen.findAllByType(FileEditorPanel)).toHaveLength(0);
            await act(async () => { show(false); });
            await act(async () => { show(true); });
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('retryLabel'));
            expect(screen.findAllByType(FileEditorPanel)).toHaveLength(0);
        } finally { await screen.unmount(); }
    });

    it('replaces settled attribution with the live writing note even with Track off, then restores it on settlement', async () => {
        const { createReducer } = await import('@happier-dev/session-core/reducer');
        const message = createToolCallMessageFixture({ id: 'writing-header', tool: { id: 'writing-header', name: 'Patch',
            input: { changes: [{ path: `${fixture.scope.rootPath}/${filePath}`, kind: { type: 'update' },
                diff: '@@ -1 +1 @@\n-export const attempts = 3;\n+export const attempts = 4;' }] },
            state: 'running', createdAt: 1, startedAt: 2, completedAt: null, description: null } });
        fixture.storage.setState({ localSettings: { ...fixture.storage.getState().localSettings, filesTrackAgentEdits: false } });
        fixture.storage.getState().applySessions([{ ...fixture.session, active: true, activeAt: Date.now(),
            thinking: true, thinkingAt: Date.now(), latestTurnStatus: 'in_progress' }]);
        fixture.storage.setState({ sessionMessages: { [fixture.session.id]: { messageIdsOldestFirst: [message.id],
            messagesById: { [message.id]: message }, messagesMap: { [message.id]: message }, reducerState: createReducer(),
            messagesVersion: 1, isLoaded: true, latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null } } });
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="session:writing-header" scope={fixture.scope} filePath={filePath}
                sessionIdForAugmentation={fixture.session.id} />
        </ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('retryLabel'));
            await vi.waitFor(() => expect(screen.findHostByTestId('file-page-writing')).not.toBeNull());
            expect(screen.findHostByTestId('file-page-attribution')).toBeNull();
            await act(async () => { fixture.storage.getState().applySessions([{ ...fixture.session, active: false,
                thinking: false, latestTurnStatus: 'completed' }]); });
            await vi.waitFor(() => expect(screen.findHostByTestId('file-page-writing')).toBeNull());
        } finally { await screen.unmount(); }
    });

    it.each(['workingTree', 'session'] as const)('opens and saves a removed-side Changes selection comment from %s', async source => {
        const selectedDiff = '--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1,2 +1,2 @@\n-old first\n-old second\n+new first\n+new second\n';
        scmDiff = source === 'workingTree' ? selectedDiff : '--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-other live text\n+unrelated live change\n';
        if (source === 'session') capturedComparison = ScmComparisonSchema.parse({ id: 'selection-comment-capture',
            source: { kind: 'session', sessionId: fixture.session.id }, repository: { rootPath: fixture.scope.rootPath }, endpoints: {},
            inventory: { state: 'complete', reasons: [], files: [{ path: filePath, changeKind: 'modified', binary: false, generated: false,
                lockfile: false, evidence: { state: 'available', unifiedDiff: selectedDiff }, occurrences: [{ id: 'capture:retry', alias: 'retry',
                    path: filePath, position: 0, before: { startLine: 1, lineCount: 2 }, after: { startLine: 1, lineCount: 2 } }] }] } });
        fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({ entries: [
            ScmWorkingEntrySchema.parse({ path: filePath, kind: 'modified', includeStatus: ' ', pendingStatus: 'M', hasPendingDelta: true }),
        ] }));
        fixture.storage.getState().applySettingsLocal({ filesDiffRendererMode: 'happier', experiments: true,
            featureToggles: { 'scm.writeOperations': true, 'files.reviewComments': true, 'files.diffSyntaxHighlighting': false, 'files.editor': false } });
        // The native renderer's DOM selection/geometry are the boundary; all page, comment and draft owners stay real.
        const root = document.createElement('div');
        const line = document.createElement('div');
        line.setAttribute('data-code-line-kind', 'remove');
        line.setAttribute('data-code-line-old', '1');
        line.append(document.createTextNode('old first'));
        root.append(line);
        document.body.append(root);
        const range = document.createRange();
        range.selectNodeContents(line);
        range.getBoundingClientRect = () => new DOMRect(20, 30, 60, 20);
        range.getClientRects = () => [new DOMRect(20, 30, 60, 20)] as unknown as DOMRectList;
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:selection-comment" scope={fixture.scope} filePath={filePath}
                initialView={{ view: 'changes' }} sessionIdForAugmentation={source === 'session' ? fixture.session.id : null} />
        </ModalProvider>, { createNodeMock: node => node.type === 'View' ? root : null });
        try {
            await vi.waitFor(() => expect(screen.findAllByType(SelectionToolbar), screen.getTextContent()).toHaveLength(1));
            await act(async () => { document.dispatchEvent(new Event('selectionchange')); });
            const toolbar = screen.findByType(SelectionToolbar);
            expect(toolbar.props.onComment).toEqual(expect.any(Function));
            await act(async () => { toolbar.props.onComment(); });
            await vi.waitFor(() => expect(screen.findAllByType(ReviewCommentInlineComposer)).toHaveLength(1));
            await act(async () => { screen.findByType(ReviewCommentInlineComposer).props.onChange('Explain the removal'); });
            await act(async () => { screen.findByType(ReviewCommentInlineComposer).props.onSave(); });
            const drafts = fixture.storage.getState().reviewCommentsDraftsByWorkspaceCacheKey[buildWorkspaceCacheKey(fixture.scope)];
            expect(drafts).toEqual([expect.objectContaining({ source: 'diff', filePath, body: 'Explain the removal',
                anchor: expect.objectContaining({ side: 'before', oldLine: 1 }), snapshot: expect.objectContaining({ selectedLines: ['old first'] }) })]);
        } finally { await screen.unmount(); root.remove(); window.getSelection()?.removeAllRanges(); }
    });

    it('opens the same inline comment composer from an ordinary Changes hunk menu', async () => {
        viewport.width = 390;
        scmDiff = '--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-old first\n+new first\n';
        fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({ entries: [
            ScmWorkingEntrySchema.parse({ path: filePath, kind: 'modified', includeStatus: ' ', pendingStatus: 'M', hasPendingDelta: true }),
        ] }));
        fixture.storage.getState().applySettingsLocal({ filesDiffRendererMode: 'happier', experiments: true,
            featureToggles: { 'scm.writeOperations': true, 'files.reviewComments': true, 'files.diffSyntaxHighlighting': false, 'files.editor': false } });
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:hunk-comment" scope={fixture.scope} filePath={filePath}
                initialView={{ view: 'changes' }} sessionIdForAugmentation={null} />
        </ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.findAllByType(HunkContextMenu)).toHaveLength(1));
            expect(screen.findByType(DiffViewer).props.virtualized).toBe(true);
            const menu = screen.findByType(HunkContextMenu);
            expect(menu.props.review.actions.comment).toEqual(expect.any(Function));
            await act(async () => { menu.props.review.actions.comment(menu.props.hunk); });
            expect(screen.findAllByType(ReviewCommentInlineComposer)).toHaveLength(1);
        } finally { await screen.unmount(); }
    });

    it('opens the inline comment composer at an editor selection and anchors a dirty buffer to the saved bytes', async () => {
        fixture.storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'scm.writeOperations': true,
            'files.reviewComments': true, 'files.diffSyntaxHighlighting': false, 'files.editor': true } });
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:editor-comment" scope={fixture.scope} filePath={filePath}
                sessionIdForAugmentation={null} />
        </ModalProvider>);
        try {
            const { FilePageHeader } = await import('../file/FilePageHeader');
            const { FileEditorPanel } = await import('../file/editor/FileEditorPanel');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('retryLabel'));
            await flushHookEffects({ cycles: 4 });
            await vi.waitFor(() => expect(screen.findByType(FilePageHeader).props.edit?.kind).toBe('edit'));
            await act(async () => { screen.findByType(FilePageHeader).props.edit.onPress(); });
            await flushHookEffects({ cycles: 4 });
            await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
            // The editor engine is the platform boundary: a dirty buffer with a line typed above the selection.
            const live = `// typed above\n${svg}`;
            const selection = { startLine: 2, endLine: 2, text: 'export const attempts = 3;', rect: { x: 40, y: 60, width: 120, height: 18 } };
            const panel = screen.findByType(FileEditorPanel);
            (panel.props.editorRef as { current: unknown }).current = { getValue: () => live, flushPendingChange: async () => {},
                getSelection: () => selection, subscribeSelection: () => () => {} };
            await act(async () => { panel.props.onReady?.(); });
            await flushHookEffects({ cycles: 2 });
            await vi.waitFor(() => expect(screen.findAllByType(SelectionToolbar)).toHaveLength(1));
            const toolbar = screen.findByType(SelectionToolbar);
            expect(toolbar.props.onComment).toEqual(expect.any(Function));
            await act(async () => { toolbar.props.onComment(); });
            // The page's one inline composer opens in the editor, which stays mounted with its buffer.
            await vi.waitFor(() => expect(screen.findAllByType(ReviewCommentInlineComposer)).toHaveLength(1));
            expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1);
            await act(async () => { screen.findByType(ReviewCommentInlineComposer).props.onChange('Why three?'); });
            await act(async () => { screen.findByType(ReviewCommentInlineComposer).props.onSave(); });
            const drafts = fixture.storage.getState().reviewCommentsDraftsByWorkspaceCacheKey[buildWorkspaceCacheKey(fixture.scope)];
            expect(drafts).toEqual([expect.objectContaining({ source: 'file', filePath, body: 'Why three?',
                anchor: expect.objectContaining({ startLine: 1, endLine: 1 }),
                snapshot: expect.objectContaining({ selectedLines: ['export const attempts = 3;'] }) })]);
            expect(screen.findAllByType(ReviewCommentInlineComposer)).toHaveLength(0);
        } finally { await screen.unmount(); }
    });

    it('gives the bottom seat to the working capsule after a phone Ask is sent, and takes it back when the turn ends', async () => {
        viewport.width = 390;
        viewport.height = 844;
        const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
        const { PhoneAskSheetProvider } = await import('@/components/sessions/composer/phoneAsk/phoneAskSheetState');
        const sheet = (phase: 'closed' | 'open' | 'working') => ({ phase, open: () => {}, close: () => {}, sent: () => {}, finish: () => {} });
        const page = (phase: 'closed' | 'open' | 'working') => <ModalProvider><PhoneAskSheetProvider value={sheet(phase)}>
            <SurfaceStateSizeProvider size="phone">
                <WorkspaceFileDetailsView scopeId="project:phone-ask-capsule" scope={fixture.scope} filePath={filePath}
                    sessionIdForAugmentation={null} />
            </SurfaceStateSizeProvider>
        </PhoneAskSheetProvider></ModalProvider>;
        let setPhase: (phase: 'closed' | 'open' | 'working') => void = () => {};
        function Harness() {
            const [phase, set] = React.useState<'closed' | 'open' | 'working'>('closed');
            setPhase = set;
            return page(phase);
        }
        const screen = await fixture.render(<Harness />);
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('retryLabel'));
            await flushHookEffects({ cycles: 4 });
            expect(screen.findHostByTestId('file-page-toolbar')).not.toBeNull();
            await act(async () => { setPhase('working'); });
            await flushHookEffects({ cycles: 2 });
            expect(screen.findHostByTestId('file-page-toolbar')).toBeNull();
            await act(async () => { setPhase('closed'); });
            await flushHookEffects({ cycles: 2 });
            expect(screen.findHostByTestId('file-page-toolbar')).not.toBeNull();
        } finally { await screen.unmount(); }
    });

    it('seats the phone selection bar above the floating tab bar, in place of the page toolbar', async () => {
        viewport.width = 390;
        viewport.height = 844;
        const { SessionCockpitBottomChromeHeightContext } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
        const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
        const { SelectionActionBar } = await import('@/components/ui/selection/SelectionActionBar');
        const { StyleSheet } = await import('react-native');
        // The code view's DOM selection is the boundary: one selected row of the read body.
        const root = document.createElement('div');
        const line = document.createElement('div');
        line.id = 'file-view-f:1';
        line.append(document.createTextNode('export const attempts = 3;'));
        root.append(line);
        document.body.append(root);
        const range = document.createRange();
        range.selectNodeContents(line);
        range.getBoundingClientRect = () => new DOMRect(20, 30, 160, 20);
        range.getClientRects = () => [new DOMRect(20, 30, 160, 20)] as unknown as DOMRectList;
        const tabBarHeight = 84;
        const screen = await fixture.render(<ModalProvider><SessionCockpitBottomChromeHeightContext.Provider value={tabBarHeight}>
            <SurfaceStateSizeProvider size="phone">
                <WorkspaceFileDetailsView scopeId="project:phone-selection" scope={fixture.scope} filePath={filePath}
                    sessionIdForAugmentation={null} />
            </SurfaceStateSizeProvider>
        </SessionCockpitBottomChromeHeightContext.Provider></ModalProvider>, { createNodeMock: node => node.type === 'View' ? root : null });
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('retryLabel'));
            await flushHookEffects({ cycles: 4 });
            expect(screen.findHostByTestId('file-page-toolbar')).not.toBeNull();
            window.getSelection()!.removeAllRanges();
            window.getSelection()!.addRange(range);
            await act(async () => { document.dispatchEvent(new Event('selectionchange')); });
            await vi.waitFor(() => expect(screen.findByType(SelectionActionBar).props.visible).toBe(true));
            await flushHookEffects({ cycles: 2 });
            // The floating tab bar covers the page's bottom: the bar clears it, and the page toolbar steps aside.
            expect(StyleSheet.flatten(screen.findByType(SelectionActionBar).parent?.props.style)).toMatchObject({ bottom: tabBarHeight });
            expect(screen.findHostByTestId('file-page-toolbar')).toBeNull();
            // ✕ puts the bar away until the selection changes, and the page toolbar comes back.
            await screen.pressByTestIdAsync('selection-bar-dismiss');
            await flushHookEffects({ cycles: 2 });
            expect(screen.findByType(SelectionActionBar).props.visible).toBe(false);
            expect(screen.findHostByTestId('file-page-toolbar')).not.toBeNull();
        } finally { await screen.unmount(); root.remove(); window.getSelection()?.removeAllRanges(); }
    });

    it('seats the phone selection bar above the Edit key row, so Save stays reachable while lines are selected', async () => {
        viewport.width = 390;
        viewport.height = 844;
        const { SessionCockpitBottomChromeHeightContext } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
        const { PageBottomBarSeatProvider } = await import('@/components/ui/layout/useFloatingChromeClearance');
        const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
        const { SelectionActionBar } = await import('@/components/ui/selection/SelectionActionBar');
        const { FilePageHeader } = await import('../file/FilePageHeader');
        const { FileEditorPanel } = await import('../file/editor/FileEditorPanel');
        const { StyleSheet } = await import('react-native');
        const tabBarHeight = 84;
        const keyRowHeight = 44;
        const screen = await fixture.render(<ModalProvider><SessionCockpitBottomChromeHeightContext.Provider value={tabBarHeight}>
            <PageBottomBarSeatProvider><SurfaceStateSizeProvider size="phone">
                <WorkspaceFileDetailsView scopeId="project:phone-edit-selection" scope={fixture.scope} filePath={filePath}
                    sessionIdForAugmentation={null} />
            </SurfaceStateSizeProvider></PageBottomBarSeatProvider>
        </SessionCockpitBottomChromeHeightContext.Provider></ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('retryLabel'));
            await flushHookEffects({ cycles: 4 });
            await vi.waitFor(() => expect(screen.findByType(FilePageHeader).props.edit?.kind).toBe('edit'));
            await act(async () => { screen.findByType(FilePageHeader).props.edit.onPress(); });
            await flushHookEffects({ cycles: 4 });
            await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
            // The editor engine is the platform boundary: one selected line.
            const selection = { startLine: 1, endLine: 1, text: 'export const attempts = 3;', rect: { x: 40, y: 60, width: 120, height: 18 } };
            const panel = screen.findByType(FileEditorPanel);
            (panel.props.editorRef as { current: unknown }).current = { getValue: () => svg, flushPendingChange: async () => {},
                getSelection: () => selection, subscribeSelection: () => () => {} };
            await act(async () => { panel.props.onReady?.(); });
            await flushHookEffects({ cycles: 2 });
            // The key row pads by the tab bar, so its box reaches from the page's bottom to its top edge.
            const keyRow = screen.findHostByTestId('code-editor-accessory');
            expect(keyRow).not.toBeNull();
            await act(async () => { keyRow?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: tabBarHeight + keyRowHeight } } }); });
            await vi.waitFor(() => expect(screen.findByType(SelectionActionBar).props.visible).toBe(true));
            await flushHookEffects({ cycles: 2 });
            // The key row is in flow and cannot step aside; the selection's bar is the one that floats, so it rides above.
            const bottom = StyleSheet.flatten(screen.findByType(SelectionActionBar).parent?.props.style).bottom as number;
            expect(bottom).toBeGreaterThan(tabBarHeight + keyRowHeight);
        } finally { await screen.unmount(); }
    });

    it('composes raw Markdown editing like code: Ask on ready, language binding, and the typed phone accessory', async () => {
        viewport.width = 390;
        const markdownPath = 'README.md';
        const markdown = '# Retry\n\nThe attempts stay at three.\n';
        transfer = createSessionFileNativeTransferBoundary({ bytes: new TextEncoder().encode(markdown), name: markdownPath });
        fixture.storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'scm.writeOperations': true,
            'files.reviewComments': false, 'files.diffSyntaxHighlighting': false, 'files.editor': true, 'files.markdownRichEditor': false } });
        const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
        const { SelectionActionBar } = await import('@/components/ui/selection/SelectionActionBar');
        const { FilePageHeader } = await import('../file/FilePageHeader');
        const { FileMarkdownEditorPanel } = await import('../file/editor/FileEditorPanel');
        const screen = await fixture.render(<ModalProvider><SurfaceStateSizeProvider size="phone">
            <WorkspaceFileDetailsView scopeId="project:raw-markdown" scope={fixture.scope} filePath={markdownPath}
                sessionIdForAugmentation={null} />
        </SurfaceStateSizeProvider></ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('attempts stay'));
            await flushHookEffects({ cycles: 4 });
            await vi.waitFor(() => expect(screen.findByType(FilePageHeader).props.edit?.kind).toBe('edit'));
            await act(async () => { screen.findByType(FilePageHeader).props.edit.onPress(); });
            await flushHookEffects({ cycles: 4 });
            await vi.waitFor(() => expect(screen.findAllByType(FileMarkdownEditorPanel)).toHaveLength(1));
            // The engine is the platform boundary: a ready raw handle with one selected line.
            const onPointerPosition = vi.fn(() => () => {});
            const selection = { startLine: 3, endLine: 3, text: 'The attempts stay at three.', rect: { x: 40, y: 60, width: 120, height: 18 } };
            const panel = screen.findByType(FileMarkdownEditorPanel);
            (panel.props.editorRef as { current: unknown }).current = { getValue: () => markdown, flushPendingChange: async () => {},
                getSelection: () => selection, subscribeSelection: () => () => {}, onPointerPosition };
            await act(async () => { panel.props.onReady?.(); });
            await flushHookEffects({ cycles: 2 });
            // Ask reaches the raw Markdown selection through the page's one control, and the page's one language
            // controller bound this ready engine, as it does for code.
            await vi.waitFor(() => expect(screen.findByType(SelectionActionBar).props.visible).toBe(true));
            expect(onPointerPosition).toHaveBeenCalled();
            // The phone key row is handed the page's language-intelligence port (Suggest / Expand / Shrink).
            expect(screen.findByType(FileMarkdownEditorPanel).props.accessory?.languageIntelligence).toBeTruthy();
        } finally { await screen.unmount(); }
    });

    it('keeps the read view up until the editor reports ready, then swaps to the editor', async () => {
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:edit-swap" scope={fixture.scope} filePath={filePath}
                sessionIdForAugmentation={null} />
        </ModalProvider>);
        try {
            const { FilePageHeader } = await import('../file/FilePageHeader');
            const { FileContentPanel } = await import('../file/FileContentPanel');
            const { FileEditorPanel } = await import('../file/editor/FileEditorPanel');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('retryLabel'));
            await flushHookEffects({ cycles: 4 });
            await vi.waitFor(() => expect(screen.findByType(FilePageHeader).props.edit?.kind).toBe('edit'));
            await act(async () => { screen.findByType(FilePageHeader).props.edit.onPress(); });
            await flushHookEffects({ cycles: 4 });
            // The engine is still loading (a cold Monaco has not booted): the editor mounts beneath, unseen and
            // untouchable, while the code view the person was reading stays on screen (P4 §3.5, files lab ED1).
            await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
            expect(screen.findAllByType(FileContentPanel)).toHaveLength(1);
            const warming = screen.findByTestId('file-details-editor-warming');
            expect(warming?.props.pointerEvents).toBe('none');
            // The engine reports ready: one swap, the read view leaves and the editor is the body.
            await act(async () => { screen.findByType(FileEditorPanel).props.onReady?.(); });
            await flushHookEffects({ cycles: 2 });
            expect(screen.findAllByType(FileContentPanel)).toHaveLength(0);
            expect(screen.findByTestId('file-details-editor-warming')).toBeNull();
            expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1);
        } finally { await screen.unmount(); }
    });
});
