import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReducer } from '@happier-dev/session-core/reducer';
import { FilesystemReadFileInputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { normalizeWorkspaceRootPathV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import { act, createToolCallMessageFixture, standardCleanup } from '@/dev/testkit';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '../views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { useSessionTrack, PhoneTrackWatchCapsule } = await import('./SessionTrack');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { PanePresentationProvider } = await import('@/components/appShell/panes/panePresentation');
const { WorkspaceNavigationProvider } = await import('@/components/appShell/workspace/WorkspaceNavigationContext');
const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
const { createWorkspaceActionAdapter } = await import('@/components/appShell/workspace/workspaceActions');
const { createWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { createWorkspaceFileDetailsTab } = await import('@/components/appShell/panes/details/fileDetailsTab');
const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
const { readWorkspaceFileLinkView } = await import('@/utils/url/sessionFileDeepLink');
const { SessionFileDetailsView } = await import('../views/SessionFileDetailsView');
const { FileContentPanel } = await import('@/components/workspaces/files/file/FileContentPanel');
const { router } = await import('expo-router');
const { parseSessionPaneUrlState, createSessionPaneDetailsTab } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { paneUiState } = await import('@/sync/domains/state/filePaneUiState');
const originalPanes = paneUiState.readAll();

let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => {
    await standardCleanup();
    replacePersistentUiStateForTest(paneUiState, originalPanes);
    await fixture?.dispose(); fixture = undefined;
    publishAppliedActiveServerRuntimeAvailability(false);
});

describe('Track/Watch file opening through the Session file owner', () => {
    it.each([
        { entry: 'track', root: '/repo', cwd: '/repo/nested', path: 'nested/tracking.ts', absolute: '/repo/nested/tracking.ts' },
        { entry: 'watch', root: '/repo', cwd: '/repo/nested', path: 'nested/tracking.ts', absolute: '/repo/nested/tracking.ts' },
        { entry: 'watchRoute', root: '/repo', cwd: '/repo/nested', path: 'nested/tracking.ts', absolute: '/repo/nested/tracking.ts' },
        { entry: 'track', root: '/repo/nested', cwd: '/repo/nested', path: 'tracking.ts', absolute: '/repo/nested/tracking.ts' },
        { entry: 'watch', root: '/repo/nested', cwd: '/repo/nested', path: 'tracking.ts', absolute: '/repo/nested/tracking.ts' },
        { entry: 'watchRoute', root: '/repo/nested', cwd: '/repo/nested', path: 'tracking.ts', absolute: '/repo/nested/tracking.ts' },
        { entry: 'track', root: '/Users/alice/repo', cwd: '/Users/alice/repo', path: 'tracking.ts', absolute: '/Users/alice/repo/tracking.ts' },
        { entry: 'watch', root: 'C:\\Users\\alice\\repo', cwd: 'C:\\Users\\alice\\repo\\nested', path: 'nested/tracking.ts', absolute: 'c:/users/alice/repo/nested/tracking.ts' },
    ])('$entry reads actual content at $absolute from cwd $cwd', async ({ entry, root, cwd, path, absolute }) => {
        const content = 'export const tracking = "the actual file";\n';
        const openedPaths: string[] = [];
        vi.mocked(router.replace).mockClear();
        fixture = await createSessionFilesViewFixture({ rootPath: cwd, serverIdentityId: 'srv_track_file_open', rpc: request => {
            if (request.method === 'statFile') return { success: true, exists: true, kind: 'file', sizeBytes: content.length };
            if (request.method === 'daemon.filesystem.readFile') {
                const input = FilesystemReadFileInputSchema.parse(request.payload);
                // Model the filesystem boundary's separator/case equivalence with the existing path owner.
                const openedPath = normalizeWorkspaceRootPathV1(input.path);
                openedPaths.push(openedPath);
                return openedPath === absolute
                    ? { success: true, content: Buffer.from(content).toString('base64') }
                    : { success: false, error: 'File does not exist' };
            }
            if (request.method === 'scm.status.snapshot') return { success: true, snapshot: fileViewSnapshot({ rootPath: root }) };
        } });
        const currentFixture = fixture;
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const { storage, session, scope } = currentFixture;
        const address = { sessionId: session.id, serverId: scope.serverId };
        const scopeId = createSessionPaneScopeId(session.id, scope.serverId);
        const message = createToolCallMessageFixture({ id: 'writing', tool: {
            // Captured FILES-LIVE63 Patch shape: the Agent already supplied an absolute target.
            id: 'writing', name: 'Patch', input: { changes: { [absolute]: {
                type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new\n',
                modify: { old_content: 'old\n', new_content: 'new\n' },
            } }, _happier: { v: 2, protocol: 'acp', provider: 'codex', rawToolName: 'Patch', canonicalToolName: 'Patch' } }, state: 'running',
            createdAt: 1, startedAt: 2, completedAt: null, description: null,
        } });
        // A turn-summary call can arrive before its result, or remain in the transcript
        // during the next turn. Its repository-relative path is not a live-write target.
        const summary = createToolCallMessageFixture({ id: 'turn-diff', tool: {
            id: 'turn-diff', name: 'Diff', input: {
                files: [{ file_path: 'nested/tracking.ts', change_kind: 'modified', source: 'provider_tool',
                    confidence: 'exact', provider: 'codex' }],
                _happier: { v: 2, protocol: 'acp', provider: 'codex', rawToolName: 'Diff', canonicalToolName: 'Diff',
                    workspaceMutationSignal: 'turn-change-set', sessionChangeScope: 'turn', turnStatus: 'completed' },
            }, state: 'running', createdAt: 3, startedAt: 3, completedAt: null, description: null,
        } });
        const messagesById = { [message.id]: message, [summary.id]: summary };
        storage.getState().applySessions([{ ...session, thinking: true, thinkingAt: Date.now(), latestTurnStatus: 'in_progress', activeAt: Date.now() }]);
        storage.setState({ localSettings: { ...storage.getState().localSettings, filesTrackAgentEdits: entry === 'track', detailsPaneTabsBehavior: 'preview' },
            sessionMessages: { [session.id]: { messageIdsOldestFirst: [message.id, summary.id], messagesById, messagesMap: messagesById,
                reducerState: createReducer(), messagesVersion: 1, isLoaded: true, latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null } } });
        currentFixture.setSnapshot(fileViewSnapshot({ rootPath: root }));
        const state = createWorkspaceState({ id: 'session-tab', target: { kind: 'session', params: { id: session.id, serverId: scope.serverId } }, pinned: true, preview: false });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
            dispatch() {}, createId: () => 'file-tab', onChange() {}, transport: { commit() {} } });
        let presentedTab: DetailsTab | undefined;
        function Scene() {
            const pane = useAppPaneScope(scopeId);
            const paneRef = React.useRef(pane);
            paneRef.current = pane;
            React.useLayoutEffect(() => {
                const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null, createId: () => 'file-tab',
                    // The mounted viewport is imperative; the real pane owner places the Action's file.
                    openFileInPlace: file => {
                        paneRef.current.openDetailsTab(createWorkspaceFileDetailsTab(file.path, file.anchor, file.anchorSource, readWorkspaceFileLinkView(file)), { intent: 'preview', present: false });
                        return true;
                    } });
                return registerMountedWorkspaceAction(async request => execute(request.actionId, request.input));
            }, []);
            useSessionTrack({ scopeId, sessionAddress: address, workspaceRoot: root, active: true });
            const tab = pane.scopeState?.details.tabs.find(candidate => candidate.key === pane.scopeState?.details.activeTabKey);
            const resource = tab?.resource;
            return <>
                {entry !== 'track' ? <PhoneTrackWatchCapsule sessionAddress={address} workspaceRoot={root} /> : null}
                {resource?.kind === 'file' ? <SessionFileDetailsView sessionId={session.id} serverId={scope.serverId} scopeId={scopeId}
                    filePath={resource.path} initialView={{ ...readWorkspaceFileLinkView(resource), view: 'view' }} /> : null}
            </>;
        }
        const screen = await currentFixture.render(<PanePresentationProvider value={entry === 'watchRoute' ? null : request => {
            if (request.pane === 'details') presentedTab = request.tab;
        }}>
            <WorkspaceNavigationProvider value={{ active: true, state, canGoBack: false, canGoForward: false,
                openHref: () => false, activateTab() {}, closeTab() {}, closeTabs() {}, dispatch() {},
                navigationForTab: () => ({ push() {}, replace() {}, back() {} }), registerBackStep: () => () => {}, back() {}, forward() {} }}>
                <Scene />
            </WorkspaceNavigationProvider>
        </PanePresentationProvider>);
        if (entry !== 'track') {
            const { HappierStatusCapsule } = await import('@happier-dev/plugin-ui/presentation');
            await act(async () => { screen.tree.root.findByType(HappierStatusCapsule).props.action.onPress(); });
        }
        if (entry === 'watchRoute') {
            await vi.waitFor(() => expect(router.replace).toHaveBeenCalled());
            const href = vi.mocked(router.replace).mock.calls.at(-1)?.[0];
            expect(typeof href).toBe('string');
            const url = new URL(String(href), 'https://happier.test');
            const details = parseSessionPaneUrlState(Object.fromEntries(url.searchParams))?.details;
            if (!details) throw new Error('Watch did not route to Session Details');
            const tab = createSessionPaneDetailsTab(details);
            if (tab?.resource?.kind !== 'file') throw new Error('Watch did not route to a file');
            const view = readWorkspaceFileLinkView(tab.resource);
            expect(view?.rootPath).toBe(root);
            await act(async () => { screen.tree.update(currentFixture.wrap(<SessionFileDetailsView sessionId={session.id}
                serverId={scope.serverId} scopeId={scopeId} filePath={path} initialView={{ ...view, view: 'view' }} />)); });
        }
        await vi.waitFor(() => expect(screen.tree.root.findAllByType(FileContentPanel)[0]?.props.fileContent,
            `Track/Watch read paths: ${openedPaths.join(', ')}`).toBe(content));
        expect(openedPaths).toContain(absolute);
        if (entry === 'watch') expect(presentedTab?.resource).toMatchObject({ path, rootPath: root });
    });
});
