import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReducer } from '@happier-dev/session-core/reducer';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { act, createMachineFixture, createSessionFixture, createToolCallMessageFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { paneUiState } = await import('@/sync/domains/state/filePaneUiState');
const { useSessionTrack, readTrackPresence } = await import('./SessionTrack');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { PanePresentationProvider } = await import('@/components/appShell/panes/panePresentation');
const { WorkspaceNavigationProvider } = await import('@/components/appShell/workspace/WorkspaceNavigationContext');
const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
const { createWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
const { createWorkspaceActionAdapter } = await import('@/components/appShell/workspace/workspaceActions');
const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { createWorkspaceFileDetailsTab, workspaceFileDetailsTabKey } = await import('@/components/appShell/panes/details/fileDetailsTab');
const { readWorkspaceFileLinkView } = await import('@/utils/url/sessionFileDeepLink');
const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
const { useWorkspaceFileOpener } = await import('@/components/workspaces/files/useWorkspaceFileOpener');
const { useFileTabFront } = await import('@/components/appShell/panes/details/useFileTabFront');
const { resolveWorkspaceTargetForSessionFromState } = await import('@/sync/domains/session/resolveWorkspaceTargetForSessionFromState');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');

const original = storage.getState();
const originalPanes = paneUiState.readAll();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let unregister: (() => void) | undefined;
afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await standardCleanup();
    replacePersistentUiStateForTest(paneUiState, originalPanes);
    await connection?.dispose();
    connection = undefined;
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.setState(original, true);
});

type ScriptedWrite = Readonly<{ id: string; name: string; input: Record<string, unknown> }>;

/** A Session whose agent is running one scripted write tool call, with the real Track composition mounted. */
async function renderSessionTrack(tool: ScriptedWrite) {
    const serverUrl = 'https://session-track-composition.test';
    const serverId = await homes.addHome({ name: 'session-track-composition', serverUrl, accountId: 'alice', currentAccount: true });
    const emptySessions = V2SessionListResponseSchema.parse({ sessions: [], hasNext: false, nextCursor: null });
    homes.answer(serverId, '/v2/sessions', { body: emptySessions });
    homes.answer(serverId, '/v2/sessions/active', { body: emptySessions });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
    if (!credentials) throw new Error('Expected Home credentials');
    connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', credentials, request: homes.request });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const sessionId = 'track-session';
    const scopeId = createSessionPaneScopeId(sessionId, serverId, 'retained-track-session');
    const session = createSessionFixture({ id: sessionId, serverId, active: true, activeAt: Date.now(),
        thinking: true, thinkingAt: Date.now(), latestTurnStatus: 'in_progress',
        metadata: { machineId: 'machine', path: '/repo', host: 'test' } });
    const message = createToolCallMessageFixture({ id: tool.id, tool: {
        ...tool, state: 'running', createdAt: 1, startedAt: 2, completedAt: null, description: null,
    } });
    const messagesById = { [message.id]: message };
    const machine = createMachineFixture({ id: 'machine' });
    storage.setState({ sessions: { [sessionId]: session }, machines: { [machine.id]: machine },
        machineListByServerId: { [serverId]: [machine] },
        localSettings: { ...storage.getState().localSettings, filesTrackAgentEdits: true, detailsPaneTabsBehavior: 'preview' },
        sessionMessages: { [sessionId]: { messageIdsOldestFirst: [message.id], messagesById, messagesMap: messagesById,
            reducerState: createReducer(), messagesVersion: 1, isLoaded: true,
            latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null } } });
    const state = createWorkspaceState({ id: 'session-tab', target: { kind: 'session', params: { id: sessionId, serverId } }, pinned: true, preview: false });
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
    const hrefs: string[] = [];
    const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
        dispatch: () => {}, createId: () => 'opened-tab', onChange: () => {}, transport: { commit: href => { hrefs.push(href); } } });
    const present = vi.fn();
    const hook = await renderHook(() => {
        const pane = useAppPaneScope(scopeId);
        const paneRef = React.useRef(pane);
        paneRef.current = pane;
        React.useLayoutEffect(() => {
            const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null, createId: () => 'opened-tab',
                // The mounted Details viewport is the imperative UI boundary. Its real pane owner handles preview and presentation.
                openFileInPlace: file => {
                    paneRef.current.openDetailsTab(createWorkspaceFileDetailsTab(file.path, file.anchor, file.anchorSource, readWorkspaceFileLinkView(file)), { intent: 'preview', present: false });
                    return true;
                } });
            unregister = registerMountedWorkspaceAction(async request => execute(request.actionId, request.input));
            return unregister;
        }, []);
        const track = useSessionTrack({ scopeId, sessionAddress: { serverId, sessionId }, workspaceRoot: '/repo', active: true });
        const opener = useWorkspaceFileOpener();
        const front = useFileTabFront(scopeId, 'a.ts', '/repo/');
        return { pane, track, opener, front, address: { serverId, sessionId } };
    }, { wrapper: ({ children }) => <AppPaneProvider><PanePresentationProvider value={present}>
        <WorkspaceNavigationProvider value={{ active: true, state, canGoBack: false, canGoForward: false,
            openHref: () => false, activateTab() {}, closeTab() {}, closeTabs() {}, dispatch() {},
            navigationForTab: () => ({ push() {}, replace() {}, back() {} }), registerBackStep: () => () => {}, back() {}, forward() {} }}>
            {children}
        </WorkspaceNavigationProvider>
    </PanePresentationProvider></AppPaneProvider> });
    return { hook, hrefs, present };
}

describe('Session Track composition', () => {
    it('shares one pinned tab for tree, Track and an equal-root captured open', async () => {
        const { hook } = await renderSessionTrack({ id: 'same-file', name: 'Write', input: { file_path: '/repo/a.ts', content: 'hello' } });
        await act(async () => { await waitForHomeGovernance(() => expect(hook.getCurrent().track.target?.path).toBe('a.ts')); });
        expect(resolveWorkspaceTargetForSessionFromState(storage.getState(), hook.getCurrent().address)?.rootPath).toBe('/repo');
        await act(async () => {
            hook.getCurrent().pane.openDetailsTab(createWorkspaceFileDetailsTab('a.ts'), { intent: 'pinned', present: false });
            hook.getCurrent().pane.openDetailsTab(createWorkspaceFileDetailsTab('a.ts', undefined, undefined, { rootPath: '/repo/' }),
                { intent: 'pinned', present: false });
            await hook.getCurrent().opener.open({ kind: 'session', ...hook.getCurrent().address, path: 'a.ts' },
                { rootPath: '/repo/', intent: 'pinned', present: false });
        });
        expect(hook.getCurrent().pane.scopeState?.details.tabs.map(tab => tab.key)).toEqual(['file:a.ts']);
        expect(hook.getCurrent().front).toBe(true);
        await hook.unmount();
    });

    it('pauses following when the current file acquires an Account-owned draft in its actual Session pane', async () => {
        const { hook } = await renderSessionTrack({ id: 'write-dirty', name: 'Write', input: { file_path: '/repo/a.ts', content: 'hello' } });
        await act(async () => { await waitForHomeGovernance(() => {
            expect(hook.getCurrent().pane.scopeState?.details.tabs).toEqual([expect.objectContaining({ key: workspaceFileDetailsTabKey('a.ts') })]);
        }); });
        await act(async () => hook.getCurrent().pane.patchDetailsTabState(workspaceFileDetailsTabKey('a.ts'), {
            accountId: 'alice', isEditingFile: true, editorOriginalHash: 'base', editorText: 'unsaved draft',
        }));
        expect(hook.getCurrent().track).toMatchObject({ paused: true, pauseReason: 'dirtyEditor', target: { path: 'a.ts' } });
        expect(hook.getCurrent().pane.scopeState?.details.tabState[workspaceFileDetailsTabKey('a.ts')]).toMatchObject({ editorText: 'unsaved draft' });
        await hook.unmount();
    });

    it('follows the current writing file through the real opener without navigating or presenting Details', async () => {
        const { hook, hrefs, present } = await renderSessionTrack({ id: 'write-a', name: 'Write', input: { file_path: '/repo/a.ts', content: 'hello' } });
        await act(async () => { await waitForHomeGovernance(() => {
            expect(hook.getCurrent().pane.scopeState?.details.tabs).toEqual([expect.objectContaining({ key: workspaceFileDetailsTabKey('a.ts'), isPreview: true, isPinned: false })]);
        }); });
        expect(hook.getCurrent().track.target?.path).toBe('a.ts');
        expect(hrefs).toEqual([]);
        expect(present).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('hands the File page the caret region from the first hunk of the applied patch and keeps it while paused', async () => {
        const { hook } = await renderSessionTrack({ id: 'patch-a', name: 'Patch', input: { changes: [{ path: '/repo/a.ts', kind: { type: 'update' },
            diff: '@@ -3 +14,2 @@\n-a\n+b\n+c\n@@ -40 +41,1 @@\n-x\n+y' }] } });
        await act(async () => { await waitForHomeGovernance(() => {
            expect(readTrackPresence(hook.getCurrent().track)).toMatchObject({ path: 'a.ts', region: { startLine: 14, endLine: 15 } });
        }); });
        // A person's scroll pauses following at once (P5-I6); the caret still says where the agent is.
        await act(async () => { hook.getCurrent().track.pause('scroll'); });
        expect(hook.getCurrent().track.paused).toBe(true);
        expect(readTrackPresence(hook.getCurrent().track)).toMatchObject({ path: 'a.ts', region: { startLine: 14, endLine: 15 } });
        await act(async () => { hook.getCurrent().track.setEnabled(false); });
        expect(readTrackPresence(hook.getCurrent().track)).toBeNull();
        await hook.unmount();
    });

    it('carries an Edit\'s replaced text for the File page to place when the call names no lines', async () => {
        const { hook } = await renderSessionTrack({ id: 'edit-a', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'return key;', new_string: 'return route;' } });
        await act(async () => { await waitForHomeGovernance(() => {
            expect(readTrackPresence(hook.getCurrent().track)).toMatchObject({ path: 'a.ts', anchorText: 'return key;' });
        }); });
        // Track asks the File page to scroll there; the page resolves the text to lines (one region owner).
        expect(readTrackPresence(hook.getCurrent().track)?.reveal).toMatchObject({ seq: expect.any(Number) });
        expect(readTrackPresence(hook.getCurrent().track)?.region).toBeUndefined();
        await hook.unmount();
    });
});
