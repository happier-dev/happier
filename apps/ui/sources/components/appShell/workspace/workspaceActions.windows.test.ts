import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homeProfileForTests, installTokenStorageTestIsolation } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { WorkspaceTabsListOutputSchema } from '@happier-dev/protocol/actions/workspaceActionFamily';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { createWorkspaceState, reduceWorkspaceState, type WorkspaceAction } from './workspaceState';
import { createWorkspaceNavigationAdapter } from './workspaceNavigationAdapter';
import { createWorkspaceActionAdapter } from './workspaceActions';
import { serializeWorkspaceLayout, workspaceLayoutScopeKey } from './workspacePersistence';
import { workspaceLayoutsState } from '@/sync/domains/state/filePaneUiState';
import { clearFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';
import type { DesktopWindowActionRequest } from '@/utils/platform/desktopWindowActionBridge';
import {
    registerDesktopAppWindowWorkspace, getDesktopAppWindowWorkspaceLayouts, getDesktopAppWindowTabPresentations,
    getDesktopAppWindows, focusDesktopAppWindow,
    focusDesktopAppWindowTab, returnDesktopAppWindowTab, closeDesktopAppWindowTab,
} from '@/desktop/window/appWindowRuntime';

const native = vi.hoisted(() => ({
    invoke: vi.fn(), listeners: new Map<string, Set<(payload: unknown) => void>>(), cancel: false,
    secure: new Map<string, string>(),
}));
// Native IPC is the external boundary; workspace, placement, draft and Action adapters stay real.
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    desktopHostKind: () => 'tauri', isDesktopHost: () => true,
    getDesktopHostWindowLabel: () => 'main',
    getDesktopHostAvailability: async () => ({ windows: { kind: 'available' } }),
    invokeDesktopHost: native.invoke,
    listenDesktopHostEvent: async (event: string, handler: (payload: unknown) => void) => {
        const listeners = native.listeners.get(event) ?? new Set();
        listeners.add(handler); native.listeners.set(event, listeners);
        return () => { listeners.delete(handler); };
    },
}));
installPanelCommonModuleMocks();
installTokenStorageTestIsolation('workspace_actions_windows');
// Match the incumbent workspace harness: recipient-envelope HTTP is outside this owner.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in window Action test'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});

const cleanups: (() => void)[] = [];
beforeEach(() => {
    cleanups.push(installLocalStorageMock().restore, installWebLockManagerMock().restore);
    native.secure.clear();
});
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    native.listeners.clear(); native.cancel = false; vi.clearAllMocks();
    clearFocusedSessionId('session', 'home');
});
function emit(event: string, payload: unknown) {
    for (const listener of native.listeners.get(event) ?? []) listener(payload);
}

async function mountWindowTabs(source = true, bodySessionId = 'session', full = false, empty = full) {
    const scope = { serverId: 'home', accountId: 'account' };
    let state = createWorkspaceState({ id: 'local', target: { kind: 'session', params: { id: 'local-session', ...scope } }, pinned: false, preview: false });
    if (source) {
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: {
            id: 'source', target: { kind: 'session', params: { id: 'session', ...scope } }, pinned: true, preview: false,
        } });
        state = reduceWorkspaceState(state, { type: 'setPresentation', tabId: 'source', presentation: { windowId: 'window' } });
        state = reduceWorkspaceState(state, { type: 'activateTab', groupId: 'group:1', tabId: 'local' });
    }
    const dispatch = (action: WorkspaceAction) => { state = reduceWorkspaceState(state, action); };
    const mainKey = workspaceLayoutScopeKey({ ...scope, windowId: 'main' });
    workspaceLayoutsState.set(mainKey, serializeWorkspaceLayout(state));
    cleanups.push(() => workspaceLayoutsState.remove(mainKey));
    const bodyId = source ? 'body' : 'no-source';
    const body = createWorkspaceState({ id: bodyId, target: { kind: 'session', params: { id: bodySessionId, ...scope } }, pinned: true, preview: false });
    const key = workspaceLayoutScopeKey({ ...scope, windowId: 'window' });
    if (!empty) workspaceLayoutsState.set(key, serializeWorkspaceLayout(body));
    cleanups.push(() => workspaceLayoutsState.remove(key));
    native.invoke.mockImplementation(async (command: string, args?: Readonly<Record<string, unknown>>) => {
        if (command === 'desktop_secure_storage_read') return native.secure.get(String(args?.key)) ?? null;
        if (command === 'desktop_secure_storage_write') { native.secure.set(String(args?.key), String(args?.value)); return; }
        if (command === 'desktop_secure_storage_remove') { native.secure.delete(String(args?.key)); return; }
        if (command === 'desktop_app_window_restore') return [];
        if (command === 'desktop_app_window_placement') return { workArea: null, previousFrame: null, frame: null };
        if (command === 'desktop_app_window_open') return { windowId: 'window', windowLabel: 'destination_window', ready: true, reused: true };
        if (command === 'desktop_window_emit_action') {
            const payload = args?.payload as DesktopWindowActionRequest;
            const returned = payload.actionIdentifier === 'desktop.window.return';
            emit('desktopWindow://action-result', { windowLabel: 'main', requestId: payload.requestId, phase: 'settled',
                ok: !native.cancel, ...(native.cancel ? { errorCode: 'workspace_navigation_cancelled', error: 'workspace_navigation_cancelled' }
                    : { result: returned ? { returned: true } : { ok: true } }) });
        }
        return undefined;
    });
    const home = homeProfileForTests(scope.serverId, 'https://home.example.test');
    await seedPersistedHomeProfilesForTests({ profiles: [home], activeServerId: home.id });
    expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
        token: `e30.${Buffer.from(JSON.stringify({ sub: scope.accountId })).toString('base64url')}.sig`,
    })).toBe(true);
    cleanups.push(registerDesktopAppWindowWorkspace({ windowId: 'main', layoutId: 'main', scope,
        getState: () => state, dispatch, catalog: [], activateTab: tabId => {
            const group = Object.values(state.groups).find(group => group.tabIds.includes(tabId));
            if (group) dispatch({ type: 'activateTab', groupId: group.id, tabId });
        }, placementMetrics: { cascadeOffset: 24, screenInset: 24 } }));
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('desktop_app_window_restore', { contexts: [scope], activeOnly: true }));
    if (source) dispatch({ type: 'setPresentation', tabId: 'source', presentation: { windowId: 'window' } });
    emit('desktopAppWindow://records', [{ windowId: 'window', accountId: 'account', homeId: 'home', layoutId: 'window',
        ...(source ? { sourceLayoutId: 'main', sourceTabId: 'source' } : {}),
        ...(full ? { chrome: 'full', selectedAddress: { kind: 'home' } } : { selectedAddress: { kind: 'session', sessionId: bodySessionId } }) }]);
    const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => [], dispatch,
        transport: { commit: () => {} }, createId: () => 'replacement', onChange: () => {} });
    const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null, createId: () => 'replacement',
        owner: { ...scope, layoutId: 'main' },
        appWindows: { scope, readLayouts: () => getDesktopAppWindowWorkspaceLayouts(scope), readPresentations: getDesktopAppWindowTabPresentations,
            readWindows: () => getDesktopAppWindows(scope), activateWindow: windowId => focusDesktopAppWindow(windowId, scope),
            activateTab: focusDesktopAppWindowTab, returnTab: returnDesktopAppWindowTab, closeTab: closeDesktopAppWindowTab } });
    return { execute, read: () => state, bodyId };
}

describe('workspace Actions for native window presentation', () => {
    it('closes a full window tab through its guard while retaining the full shell', async () => {
        const owner = await mountWindowTabs(false, 'session', true, false);
        const context = { surface: 'agent' as const, authority: 'account_automation' as const, actionRequestId: 'close-full-tab' };
        const address = { kind: 'workspaceTab' as const, serverId: 'home', accountId: 'account', layoutId: 'window', tabId: 'no-source' };
        native.cancel = true;
        expect(await owner.execute('workspace.tabs.close', { address }, context)).toMatchObject({ ok: false });
        native.cancel = false;
        expect(await owner.execute('workspace.tabs.close', { address }, context)).toEqual({ ok: true });
        expect(native.invoke.mock.calls.filter(([command]) => command === 'desktop_app_window_close')).toHaveLength(0);
        expect(getDesktopAppWindows({ serverId: 'home', accountId: 'account' })).toContainEqual(expect.objectContaining({ windowId: 'window' }));
    });
    it('activates a full window tab through its admitted mounted owner without retargeting or closing the shell', async () => {
        const owner = await mountWindowTabs(false, 'session', true, false);
        const before = owner.read();
        const context = { surface: 'agent' as const, authority: 'account_automation' as const, actionRequestId: 'activate-full' };
        expect(await owner.execute('workspace.tabs.activate', { address: { kind: 'workspaceTab',
            serverId: 'home', accountId: 'account', layoutId: 'window', tabId: 'no-source' } }, context)).toEqual({ ok: true });
        expect(owner.read()).toBe(before);
        expect(native.invoke).toHaveBeenCalledWith('desktop_window_emit_action', expect.objectContaining({ payload: expect.objectContaining({
            targetWindowLabel: 'destination_window', actionIdentifier: 'desktop.clientAction.execute.admitted',
            data: expect.objectContaining({ request: expect.objectContaining({ actionId: 'workspace.tabs.activate', input: { tabId: 'no-source' }, context }) }),
        }) }));
        expect(native.invoke.mock.calls.filter(([command]) => command === 'desktop_app_window_open')).toHaveLength(1);
        expect(native.invoke.mock.calls.filter(([command]) => command === 'desktop_app_window_close')).toHaveLength(0);
    });
    it('discovers and activates an empty full shell without creating tabs or changing its destination', async () => {
        const owner = await mountWindowTabs(false, 'session', true);
        const before = owner.read();
        const result = WorkspaceTabsListOutputSchema.parse(await owner.execute('workspace.tabs.list', {}));
        expect(result.windows).toContainEqual(expect.objectContaining({ windowId: 'window', chrome: 'full', role: 'secondary',
            serverId: 'home', accountId: 'account', layoutId: 'window' }));
        expect(result.tabs.map(tab => tab.id)).toEqual(['local']);
        expect(await owner.execute('workspace.tabs.activate', { windowId: 'window' })).toEqual({ ok: true });
        expect(owner.read()).toBe(before);
        expect(native.invoke).toHaveBeenCalledWith('desktop_app_window_open', expect.objectContaining({ record: expect.objectContaining({
            windowId: 'window', chrome: 'full', selectedAddress: { kind: 'home' },
        }) }));
        expect(await owner.execute('workspace.tabs.activate', { windowId: 'retired' })).toMatchObject({ ok: false });
    });
    it('lists source placement and actual native focus without duplicating its mounted alias', async () => {
        const owner = await mountWindowTabs();
        emit('desktopAppWindow://lifecycle', { kind: 'focused', windowId: 'window', focused: true });
        await vi.waitFor(() => expect(getDesktopAppWindowTabPresentations()[0]?.focused).toBe(true));
        const result = WorkspaceTabsListOutputSchema.parse(await owner.execute('workspace.tabs.list', {}));
        expect(result.tabs.map(tab => tab.id)).toEqual(['local', 'source']);
        expect(result.tabs.find(tab => tab.id === 'source')?.presentation).toEqual({ windowId: 'window', focused: true });
    });

    it('lists a no-source tab from its saved layout with a distinct projected group', async () => {
        const owner = await mountWindowTabs(false);
        const result = WorkspaceTabsListOutputSchema.parse(await owner.execute('workspace.tabs.list', {}));
        const tab = result.tabs.find(tab => tab.id === 'no-source');
        expect(tab).toMatchObject({ target: { kind: 'session', params: { id: 'session', serverId: 'home', accountId: 'account' } },
            pinned: true, presentation: { windowId: 'window', focused: false } });
        expect(tab?.groupId).not.toBe('group:1');
        expect(result.groups.find(group => group.id === tab?.groupId)?.tabIds).toEqual(['no-source']);
        expect(result.rootNodeId).toBe(owner.read().root.id);
    });

    it('retains the current no-source body after retarget while listing its dormant source', async () => {
        const owner = await mountWindowTabs(true, 'retargeted-session');
        const result = WorkspaceTabsListOutputSchema.parse(await owner.execute('workspace.tabs.list', {}));
        expect(result.tabs.map(tab => tab.id)).toEqual(['local', 'source', 'body']);
        const bodyTab = result.tabs.find(tab => tab.id === 'body');
        expect(bodyTab && 'target' in bodyTab ? bodyTab.target.params.id : undefined).toBe('retargeted-session');
        expect(result.groups.find(group => group.id === result.tabs.find(tab => tab.id === 'body')?.groupId)?.tabIds).toEqual(['body']);
    });

    it('activates a source in its native window while retaining the main selection', async () => {
        const owner = await mountWindowTabs();
        const before = owner.read();
        expect(await owner.execute('workspace.tabs.activate', { tabId: 'source' })).toEqual({ ok: true });
        expect(owner.read().groups['group:1'].activeTabId).toBe(before.groups['group:1'].activeTabId);
        expect(native.invoke).toHaveBeenCalledWith('desktop_app_window_open', expect.objectContaining({ record: expect.objectContaining({ windowId: 'window' }) }));
    });

    it('returns a no-source tab before the existing move reducer and keeps cancellation intact', async () => {
        const owner = await mountWindowTabs(false);
        const before = owner.read();
        native.cancel = true;
        expect(await owner.execute('workspace.tabs.move', { tabId: 'no-source', targetGroupId: 'group:1' }))
            .toMatchObject({ ok: false, errorCode: 'workspace_navigation_cancelled' });
        expect(owner.read()).toBe(before);
        native.cancel = false;
        expect(await owner.execute('workspace.tabs.move', { tabId: 'no-source', targetGroupId: 'group:1', beforeTabId: 'local' })).toEqual({ ok: true });
        expect(owner.read().groups['group:1'].tabIds).toEqual(['no-source', 'local']);
        expect(owner.read().tabs['no-source'].presentation).toBeUndefined();
    });

    it('retains admitted caller authority through the mounted window guard before removing the canonical source', async () => {
        const owner = await mountWindowTabs();
        const before = owner.read();
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            actionRequestId: 'admitted-window-close' };
        native.cancel = true;
        expect(await owner.execute('workspace.tabs.close', { tabId: 'source' }, context)).toMatchObject({ ok: false, errorCode: 'workspace_navigation_cancelled' });
        expect(owner.read()).toBe(before);
        native.cancel = false;
        expect(await owner.execute('workspace.tabs.close', { tabId: 'source' }, context)).toEqual({ ok: true });
        expect(owner.read().tabs.source).toBeUndefined();
        expect(owner.read().tabs.local).toBeDefined();
        expect(native.invoke).toHaveBeenCalledWith('desktop_window_emit_action', expect.objectContaining({ payload: expect.objectContaining({
            targetWindowLabel: 'destination_window', actionIdentifier: 'desktop.clientAction.execute.admitted',
            data: expect.objectContaining({ request: expect.objectContaining({ actionId: 'workspace.tabs.close', input: { tabId: 'body' }, context }) }),
        }) }));
    });
});
