import { describe, expect, it } from 'vitest';
import { WorkspaceTabsListOutputSchema } from '@happier-dev/protocol/actions/workspaceActionFamily';
import { createWorkspaceActionAdapter, selectWorkspaceTabsToClose } from './workspaceActions';
import { createWorkspaceNavigationAdapter } from './workspaceNavigationAdapter';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import type { AppPaneContextValue } from '../panes/AppPaneContext';
import { appPaneReduce, createAppPaneState } from '../panes/model/appPaneReducer';
import { activatePaneWindowTab, closePaneWindowTab, listPaneWindowTabs, movePaneWindowTab } from '../panes/paneTabWindowTransfer';
import { createPaneOverlayFocusReturnOwner } from '../panes/paneOverlayFocusReturn';
import { createFileFindSeedHandoff } from '../panes/fileFindSeedHandoff';
import { detailsTabNavigationKey } from '../panes/details/workspace/detailsTabLifetime';
import { registerMountedTabUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';

describe('workspace Action qualified addresses', () => {
    it('activates, moves and guarded-closes the real pane owner without touching a colliding workspace tab', async () => {
        const state = createWorkspaceState({ id: 'file:a.ts', target: { kind: 'session', params: { id: 'workspace-session' } }, pinned: false, preview: false });
        const owner = { serverId: 'home-a', accountId: 'account-a', layoutId: 'main' };
        const scopeId = 'workspace:pane:workspace-session:session:address:home-a:pane-session';
        const otherScope = 'workspace:pane:other:session:address:home-b:pane-session';
        let paneState = createAppPaneState({ maxScopesInMemory: 2 });
        const dispatch: AppPaneContextValue['dispatch'] = action => { paneState = appPaneReduce(paneState, action); };
        for (const id of [scopeId, otherScope]) for (const key of ['file:a.ts', 'file:b.ts']) dispatch({ type: 'openDetailsTab', scopeId: id,
            tab: { key, kind: 'file', title: key, resource: { path: key.slice(5) } }, openAs: 'pinned' });
        const original = paneState.scopes[scopeId].details.focusedGroupId!;
        dispatch({ type: 'splitDetailsGroup', scopeId, axis: 'horizontal' });
        const targetGroupId = Object.keys(paneState.scopes[scopeId].details.groupsById).find(id => id !== original)!;
        const context: AppPaneContextValue = { get state() { return paneState; }, getReadState: () => paneState,
            dispatch, registerDriver: () => () => {}, getDriver: () => null, driverRegistryVersion: 0,
            detailsStartScopeId: null, presentDetailsStart: () => {},
            overlayFocusReturnOwner: createPaneOverlayFocusReturnOwner(), fileFindSeedHandoff: createFileFindSeedHandoff(),
            fileFindSeedAccountBindings: new Map() };
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => [],
            dispatch: () => { throw new Error('Pane Action must keep workspace membership'); },
            transport: { commit: () => {} }, createId: () => 'new', onChange: () => {} });
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, owner,
            readCanvas: () => null, createId: () => 'new', panes: {
                listTabs: () => listPaneWindowTabs(context, { ...owner, scopeIds: [scopeId, otherScope] }),
                activateTab: address => activatePaneWindowTab(context, address),
                closeTab: address => closePaneWindowTab(context, address),
                moveTab: (address, group) => movePaneWindowTab(context, address, group),
            } });
        const address = { kind: 'paneTab' as const, ...owner, scopeId, tabKey: 'file:a.ts' };
        const listed = WorkspaceTabsListOutputSchema.parse(await execute('workspace.tabs.list', {}));
        expect(listed.tabs.filter(tab => tab.address?.kind === 'paneTab')).toHaveLength(2);
        expect(selectWorkspaceTabsToClose(state, 'workspace.tabs.close', { address }, owner)).toBeNull();
        expect(await execute('workspace.tabs.activate', { address })).toEqual({ ok: true });
        expect(paneState.scopes[scopeId].details.groupsById[original].activeTabKey).toBe('file:a.ts');
        expect(await execute('workspace.tabs.move', { address, targetGroupId })).toEqual({ ok: true });
        expect(paneState.scopes[scopeId].details.groupsById[targetGroupId].tabKeys).toContain('file:a.ts');
        let decision: 'keepEditing' | 'discard' = 'keepEditing';
        const release = registerMountedTabUnsavedChangesGuard(detailsTabNavigationKey(scopeId, address.tabKey), {
            tag: 'pane-file', isDirtyRef: { current: true }, requestDecision: async () => decision,
        });
        try {
            expect(await execute('workspace.tabs.close', { address })).toMatchObject({ ok: false, errorCode: 'workspace_navigation_cancelled' });
            expect(paneState.scopes[scopeId].details.tabsByKey[address.tabKey]).toBeDefined();
            decision = 'discard';
            expect(await execute('workspace.tabs.close', { address })).toEqual({ ok: true });
            expect(paneState.scopes[scopeId].details.tabsByKey[address.tabKey]).toBeUndefined();
            expect(paneState.scopes[otherScope].details.tabsByKey[address.tabKey]).toBeDefined();
            expect(state.tabs[address.tabKey]).toBeDefined();
        } finally { release(); context.fileFindSeedHandoff.dispose(); }
    });
    it('keeps colliding window tab ids qualified by their owning Home, Account and layout', async () => {
        let state = createWorkspaceState({ id: 'same', target: { kind: 'session', params: { id: 'local' } }, pinned: false, preview: false });
        const owner = { serverId: 'home-a', accountId: 'account-a', layoutId: 'main' };
        const address = { kind: 'workspaceTab' as const, ...owner, tabId: 'same' };
        const remote = { ...address, layoutId: 'destination-1' };
        const otherHome = { ...remote, serverId: 'home-b' };
        const otherAccount = { ...remote, accountId: 'account-b' };
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => [],
            dispatch: action => { state = reduceWorkspaceState(state, action); },
            transport: { commit: () => {} }, createId: () => 'new', onChange: () => {} });
        // Native window commands are the process boundary; workspace navigation stays real.
        const activated: unknown[] = [];
        const moved: unknown[] = [];
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, owner,
            readCanvas: () => null, createId: () => 'new', appWindows: {
                scope: owner, readPresentations: () => [], readWindows: () => [], activateWindow: async () => false,
                readLayouts: () => [remote, otherHome, otherAccount].map((tabAddress, index) => ({ windowId: `window-${index}`,
                    layout: { ok: true as const, tabs: [{ id: 'same', groupId: 'group:1', address: tabAddress,
                        target: { kind: 'session', params: { id: `remote-${index}`, serverId: tabAddress.serverId, accountId: tabAddress.accountId } },
                        pinned: false, preview: false, presentation: { windowId: `window-${index}` } }],
                    groups: [{ id: 'group:1', tabIds: ['same'], activeTabId: 'same' }], splits: [],
                    rootNodeId: 'group:1', focusedGroupId: 'group:1', maximizedGroupId: null } })),
                activateTab: async selected => { activated.push(selected); return true; },
                returnTab: async () => false, closeTab: async () => true,
                moveTab: async (selected, group) => { moved.push({ selected, group }); return true; },
            } });
        const listed = WorkspaceTabsListOutputSchema.parse(await execute('workspace.tabs.list', {}));
        expect(listed.tabs.map(tab => tab.address)).toEqual([address, remote, otherHome, otherAccount]);
        expect(await execute('workspace.tabs.activate', { tabId: 'same' })).toEqual({ ok: true });
        expect(activated).toEqual([]);
        expect(await execute('workspace.tabs.activate', { address: remote })).toEqual({ ok: true });
        expect(activated).toEqual([remote]);
        expect(await execute('workspace.tabs.close', { address: otherAccount })).toEqual({ ok: true });
        expect(await execute('workspace.tabs.move', { address: remote, targetGroupId: listed.tabs[1].groupId })).toEqual({ ok: true });
        expect(moved).toEqual([{ selected: remote, group: 'group:1' }]);
        expect(state.tabs.same.target.params.id).toBe('local');
        expect(selectWorkspaceTabsToClose(state, 'workspace.tabs.close', { address }, owner))
            .toEqual({ groupId: 'group:1', tabIds: ['same'] });
        expect(selectWorkspaceTabsToClose(state, 'workspace.tabs.close', { address: remote }, owner)).toBeNull();
        expect(await execute('workspace.tabs.close', { address })).toEqual({ ok: true });
        expect(state.tabs.same).toBeUndefined();
    });
});
