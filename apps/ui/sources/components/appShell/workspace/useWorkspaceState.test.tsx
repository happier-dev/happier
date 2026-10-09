import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { createWorkspaceState, reduceWorkspaceState, type WorkspaceState } from './workspaceState';
import { workspaceLayoutScopeKey } from './workspacePersistence';
import { admitWorkspaceSingletonState } from './workspaceDestinationPolicy';
import type { CompactAppDestination } from '../destinations/compactAppDestinationCatalog';

const initialTab = {
    id: 'new', target: { kind: 'newTab', params: {} }, pinned: false, preview: true,
};
const storedTab = {
    id: 'session-a', target: { kind: 'session', params: { id: 'session-a', serverId: 'home' } },
    pinned: true, preview: false,
};

const storageState = vi.hoisted(() => ({
    ready: false,
    scope: { serverId: 'home', accountId: 'alice' },
    layouts: {} as Record<string, unknown>,
}));
const saveLayouts = vi.hoisted(() => vi.fn((next: Record<string, unknown>) => { storageState.layouts = next; }));
const pluginKind = 'plugin:acme.notes:notes';
const pluginCatalog = [{ id: pluginKind, kind: 'plugin', container: 'appPage', destination: { pluginId: 'acme.notes', localId: 'notes' },
    title: 'Notes', icon: 'file', order: 40, placement: { kind: 'rail', region: 'plugins' },
    activation: 'navigate', availability: 'available', routePath: '/plugins/acme.notes/notes',
}] satisfies readonly CompactAppDestination[];
const duplicateState = () => reduceWorkspaceState(createWorkspaceState({ id: 'first', target: { kind: pluginKind, params: { subPath: 'first' } }, pinned: false, preview: false }),
    { type: 'openTab', groupId: 'group:1', tab: { id: 'second', target: { kind: pluginKind, params: { subPath: 'last' } }, pinned: false, preview: false } });
const admission = (catalog: readonly CompactAppDestination[]) => (state: WorkspaceState) => {
    return admitWorkspaceSingletonState(state, catalog, () => 'blank');
};

vi.mock('@/sync/domains/state/storage', () => createStorageModuleStub({
    useIsDataReady: () => storageState.ready,
    useActiveServerAccountScope: () => storageState.scope,
    useLocalSettingMutable: (key: string) => {
        if (key !== 'workspaceLayoutV1') throw new Error(`Unexpected setting: ${key}`);
        return [storageState.layouts, saveLayouts] as const;
    },
}));

describe('useWorkspaceState', () => {
    it.each(['restore', 'sync'] as const)('admits duplicate workflow details from %s without writing or changing unrelated tabs', async source => {
        storageState.ready = true;
        const first = { id: 'workflow-first', target: { kind: 'workflow', params: { id: 'workflow-1' } }, pinned: true, preview: false };
        const duplicate = { ...first, id: 'workflow-duplicate', pinned: false, preview: true };
        let saved = reduceWorkspaceState(createWorkspaceState(first), { type: 'openTab', groupId: 'group:1', tab: storedTab });
        saved = reduceWorkspaceState(saved, { type: 'openTab', groupId: 'group:1', tab: duplicate });
        const scopeKey = workspaceLayoutScopeKey({ ...storageState.scope, windowId: 'window-a' });
        if (source === 'restore') storageState.layouts = { [scopeKey]: saved };
        const { useWorkspaceState } = await import('./useWorkspaceState');
        const hook = await renderHook(() => useWorkspaceState({ initialTab, windowId: 'window-a', admitState: admission([]) }));
        if (source === 'sync') act(() => hook.getCurrent().applySharedRecord({ v: 1,
            order: ['workflow-first', 'session-a', 'workflow-duplicate'], pairs: [], tabsById: {
                'workflow-first': first, 'session-a': storedTab, 'workflow-duplicate': { ...duplicate, preview: false },
            } }));
        expect(Object.values(hook.getCurrent().state.tabs).filter(tab => tab.target.kind === 'workflow')).toHaveLength(1);
        expect(hook.getCurrent().state.tabs['workflow-first']).toMatchObject({ pinned: source === 'restore', preview: false });
        expect(hook.getCurrent().state.tabs['session-a']).toEqual(storedTab);
        if (source === 'restore') {
            const state = hook.getCurrent().state;
            expect(state.groups[state.focusedGroupId].activeTabId).toBe('workflow-first');
        }
        expect(saveLayouts).not.toHaveBeenCalled();
        await hook.unmount();
    });
    it('leaves non-singleton preview disposition intact while admitting a plugin singleton', async () => {
        storageState.ready = true;
        let saved = reduceWorkspaceState(createWorkspaceState({ id: 'first', target: { kind: pluginKind, params: {} }, pinned: true, preview: false }),
            { type: 'openTab', groupId: 'group:1', tab: { id: 'second', target: { kind: pluginKind, params: { subPath: 'last' } }, pinned: false, preview: true } });
        saved = reduceWorkspaceState(saved, { type: 'splitTab', tabId: 'second', sourceGroupId: 'group:1', targetGroupId: 'group:1',
            newGroupId: 'second-group', axis: 'row', placement: 'after', availableSizePx: 1200, minimumFirstSizePx: 300, minimumSecondSizePx: 300 });
        saved = reduceWorkspaceState(saved, { type: 'openTab', groupId: 'group:1', tab: storedTab });
        const sessionPreview = { id: 'session-preview', target: { kind: 'session', params: { id: 'session-b', serverId: 'home' } }, pinned: false, preview: true };
        saved = reduceWorkspaceState(saved, { type: 'openTab', groupId: 'group:1', tab: sessionPreview });
        const scopeKey = workspaceLayoutScopeKey({ ...storageState.scope, windowId: 'window-a' });
        storageState.layouts = { [scopeKey]: saved };
        let admitState = admission([]);
        const { useWorkspaceState } = await import('./useWorkspaceState');
        const hook = await renderHook(() => useWorkspaceState({ initialTab, windowId: 'window-a', admitState }));
        admitState = admission(pluginCatalog);
        await hook.rerender(undefined);
        expect(hook.getCurrent().state.tabs.second).toBeUndefined();
        expect(hook.getCurrent().state.tabs.first.target.params.subPath).toBe('last');
        expect(hook.getCurrent().state.tabs['session-a']).toEqual(storedTab);
        expect(hook.getCurrent().state.tabs['session-preview']).toEqual(sessionPreview);
        expect(saveLayouts).not.toHaveBeenCalled();
        await hook.unmount();
    });
    it('preserves an intentional pin when a later preview retargets a restored singleton, then accepts explicit unpin', async () => {
        storageState.ready = true;
        const saved = reduceWorkspaceState(createWorkspaceState({ id: 'first', target: { kind: pluginKind, params: { subPath: 'first' } }, pinned: true, preview: false }),
            { type: 'openTab', groupId: 'group:1', tab: { id: 'second', target: { kind: pluginKind, params: { subPath: 'last' } }, pinned: false, preview: true } });
        const scopeKey = workspaceLayoutScopeKey({ ...storageState.scope, windowId: 'window-a' });
        storageState.layouts = { [scopeKey]: saved };
        let admitState = admission([]);
        const { useWorkspaceState } = await import('./useWorkspaceState');
        const hook = await renderHook(() => useWorkspaceState({ initialTab, windowId: 'window-a', admitState }));
        expect(hook.getCurrent().state.tabs.second).toBeDefined();
        admitState = admission(pluginCatalog);
        await hook.rerender(undefined);
        expect(hook.getCurrent().state.tabs.first).toMatchObject({ pinned: true, preview: false, target: { params: { subPath: 'last' } } });
        expect(hook.getCurrent().state.tabs.second).toBeUndefined();
        expect(hook.getCurrent().getState()).toBe(hook.getCurrent().state);
        expect(saveLayouts).not.toHaveBeenCalled();
        act(() => hook.getCurrent().dispatch({ type: 'setPinned', tabId: 'first', pinned: false }));
        await hook.rerender(undefined);
        expect(hook.getCurrent().state.tabs.first).toMatchObject({ pinned: false, preview: false });
        expect((storageState.layouts[scopeKey] as WorkspaceState).tabs.first.pinned).toBe(false);
        expect(saveLayouts).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });
    it.each([false, true])('admits preview duplicates across groups and promotes only a merged sticky disposition: sticky=%s', async sticky => {
        storageState.ready = true;
        let saved = duplicateState();
        saved = reduceWorkspaceState(saved, { type: 'splitTab', tabId: 'second', sourceGroupId: 'group:1', targetGroupId: 'group:1',
            newGroupId: 'second-group', axis: 'row', placement: 'after', availableSizePx: 1200, minimumFirstSizePx: 300, minimumSecondSizePx: 300 });
        // The persisted local schema admits one preview per group.
        saved = { ...saved, tabs: { ...saved.tabs, first: { ...saved.tabs.first, preview: true }, second: { ...saved.tabs.second, pinned: sticky, preview: !sticky } } };
        const scopeKey = workspaceLayoutScopeKey({ ...storageState.scope, windowId: 'window-a' });
        storageState.layouts = { [scopeKey]: saved };
        const admitState = admission(pluginCatalog);
        const { useWorkspaceState } = await import('./useWorkspaceState');
        const hook = await renderHook(() => useWorkspaceState({ initialTab, windowId: 'window-a', admitState }));
        expect(Object.values(hook.getCurrent().state.tabs).filter(tab => tab.target.kind === pluginKind)).toHaveLength(1);
        expect(hook.getCurrent().state.tabs.first.preview).toBe(!sticky);
        expect(hook.getCurrent().state.tabs.first.pinned).toBe(sticky);
        expect(hook.getCurrent().state.tabs.first.target.params.subPath).toBe('last');
        expect(hook.getCurrent().getState()).toBe(hook.getCurrent().state);
        expect(saveLayouts).not.toHaveBeenCalled();
        await hook.unmount();
    });
    it.each([true, false])('admits a known singleton catalog during non-writing restore, including before readiness: ready=%s', async ready => {
        storageState.ready = ready;
        const scopeKey = workspaceLayoutScopeKey({ ...storageState.scope, windowId: 'window-a' });
        storageState.layouts = { [scopeKey]: duplicateState() };
        const admitState = admission(pluginCatalog);
        const { useWorkspaceState } = await import('./useWorkspaceState');
        const hook = await renderHook(() => useWorkspaceState({ initialTab, windowId: 'window-a', admitState }));
        if (!ready) { storageState.ready = true; await hook.rerender(undefined); }
        expect(Object.values(hook.getCurrent().state.tabs).filter(tab => tab.target.kind === pluginKind)).toHaveLength(1);
        expect(hook.getCurrent().state.tabs.first.target.params.subPath).toBe('last');
        expect(hook.getCurrent().getState()).toBe(hook.getCurrent().state);
        expect(saveLayouts).not.toHaveBeenCalled();
        act(() => hook.getCurrent().dispatch({ type: 'setPinned', tabId: 'first', pinned: true }));
        expect((storageState.layouts[scopeKey] as WorkspaceState).tabs.second).toBeUndefined();
        expect(saveLayouts).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });
    it('applies a later singleton admission policy to the same canonical state without writing layouts', async () => {
        storageState.ready = true;
        const scopeKey = workspaceLayoutScopeKey({ ...storageState.scope, windowId: 'window-a' });
        storageState.layouts = { [scopeKey]: duplicateState() };
        let admitState = admission([]);
        const { useWorkspaceState } = await import('./useWorkspaceState');
        const hook = await renderHook(() => useWorkspaceState({ initialTab, windowId: 'window-a', admitState }));
        expect(hook.getCurrent().state.tabs.second).toBeDefined();
        admitState = admission(pluginCatalog);
        await hook.rerender(undefined);
        expect(hook.getCurrent().state.tabs.second).toBeUndefined();
        expect(hook.getCurrent().getState()).toBe(hook.getCurrent().state);
        expect(saveLayouts).not.toHaveBeenCalled();
        await hook.unmount();
    });
    it('imports shared membership without writing layouts or stealing focus, then saves it with an explicit intent', async () => {
        storageState.ready = true;
        const { useWorkspaceState } = await import('./useWorkspaceState');
        const hook = await renderHook(() => useWorkspaceState({ initialTab, windowId: 'window-a' }));
        act(() => hook.getCurrent().dispatch({ type: 'openTab', groupId: 'group:1', tab: storedTab }));
        const root = hook.getCurrent().getState().root;
        const saved = storageState.layouts;
        act(() => hook.getCurrent().applySharedRecord({ v: 1, tabsById: {
            'session-a': { id: storedTab.id, target: storedTab.target, pinned: true },
            remote: { id: 'remote', target: { kind: 'futurePlugin', params: { page: 'opaque' } }, pinned: false },
        }, order: ['session-a', 'remote'], pairs: [] }));
        expect(hook.getCurrent().state.groups['group:1'].activeTabId).toBe('session-a');
        expect(hook.getCurrent().state.root).toBe(root);
        expect(hook.getCurrent().state.tabs.remote.target.kind).toBe('futurePlugin');
        const scopeKey = workspaceLayoutScopeKey({ ...storageState.scope, windowId: 'window-a' });
        expect(storageState.layouts).toBe(saved);
        const before = saveLayouts.mock.calls.length;
        act(() => hook.getCurrent().applySharedRecord({ v: 1, tabsById: {
            'session-a': { id: storedTab.id, target: storedTab.target, pinned: true },
            remote: { id: 'remote', target: { kind: 'futurePlugin', params: { page: 'opaque' } }, pinned: false },
        }, order: ['session-a', 'remote'], pairs: [] }));
        expect(saveLayouts.mock.calls.length).toBe(before);
        act(() => hook.getCurrent().dispatch({ type: 'setPinned', tabId: 'remote', pinned: true }));
        expect((storageState.layouts[scopeKey] as ReturnType<typeof createWorkspaceState>).tabs.remote).toMatchObject({ pinned: true });
        await hook.unmount();
    });
    it('exposes the synchronous owner state across composed intents before React renders', async () => {
        storageState.ready = true;
        const { useWorkspaceState } = await import('./useWorkspaceState');
        const hook = await renderHook(() => useWorkspaceState({ initialTab, windowId: 'window-a' }));
        act(() => {
            const owner = hook.getCurrent();
            owner.dispatch({ type: 'openTab', groupId: 'group:1', tab: storedTab });
            expect(owner.getState().groups['group:1'].activeTabId).toBe('session-a');
            owner.dispatch({ type: 'setTarget', tabId: 'session-a', target: { kind: 'session', params: { id: 'session-b', serverId: 'home-b' } } });
            expect(owner.getState().tabs['session-a'].target.params).toEqual({ id: 'session-b', serverId: 'home-b' });
        });
        await hook.unmount();
    });
    it('restores a reordered local tab and keeps its position when shared tabs are imported again', async () => {
        storageState.ready = true;
        const { useWorkspaceState } = await import('./useWorkspaceState');
        let hook = await renderHook(() => useWorkspaceState({ initialTab, windowId: 'window-a' }));
        const second = { ...storedTab, id: 'session-b', target: { ...storedTab.target, params: { id: 'session-b', serverId: 'home' } } };
        act(() => {
            hook.getCurrent().dispatch({ type: 'openTab', groupId: 'group:1', tab: storedTab });
            hook.getCurrent().dispatch({ type: 'openTab', groupId: 'group:1', tab: second });
            hook.getCurrent().dispatch({ type: 'reorderTab', groupId: 'group:1', tabId: 'new', index: 1 });
        });
        const expectedOrder = ['session-a', 'new', 'session-b'];
        expect(hook.getCurrent().state.groups['group:1'].tabIds).toEqual(expectedOrder);
        await hook.unmount();
        hook = await renderHook(() => useWorkspaceState({ initialTab, windowId: 'window-a' }));
        expect(hook.getCurrent().state.groups['group:1'].tabIds).toEqual(expectedOrder);
        const restored = hook.getCurrent().state;
        act(() => hook.getCurrent().applySharedRecord({ v: 1, tabsById: { 'session-a': storedTab, 'session-b': second },
            order: ['session-a', 'session-b'], pairs: [] }));
        expect(hook.getCurrent().state).toBe(restored);
        expect(hook.getCurrent().state.groups['group:1'].tabIds).toEqual(expectedOrder);
        await hook.unmount();
    });
    afterEach(() => {
        storageState.ready = false;
        storageState.scope = { serverId: 'home', accountId: 'alice' };
        storageState.layouts = {};
        saveLayouts.mockClear();
        standardCleanup();
    });

    it('hydrates the account/window layout without writing on mount and persists only an intent', async () => {
        const scopeKey = workspaceLayoutScopeKey({ ...storageState.scope, windowId: 'window-a' });
        const { useWorkspaceState } = await import('./useWorkspaceState');
        const hook = await renderHook(() => useWorkspaceState({ initialTab, windowId: 'window-a' }));
        expect(hook.getCurrent().state.tabs.new).toBeTruthy();
        expect(saveLayouts).not.toHaveBeenCalled();

        storageState.ready = true;
        storageState.layouts = { [scopeKey]: createWorkspaceState(storedTab) };
        await hook.rerender(undefined);
        expect(hook.getCurrent().state.tabs['session-a']).toBeTruthy();
        expect(saveLayouts).not.toHaveBeenCalled();

        act(() => hook.getCurrent().dispatch({ type: 'openTab', groupId: 'group:1', tab: initialTab }));
        expect(saveLayouts).toHaveBeenCalledTimes(1);
        expect((storageState.layouts[scopeKey] as ReturnType<typeof createWorkspaceState>).groups['group:1']?.tabIds).toEqual(['session-a', 'new']);
        await hook.unmount();
    });

    it('never presents a previous Account tab while switching Account scopes', async () => {
        storageState.ready = true;
        const aliceScopeKey = workspaceLayoutScopeKey({ ...storageState.scope, windowId: 'window-a' });
        storageState.layouts = { [aliceScopeKey]: createWorkspaceState(storedTab) };
        const observed: Array<{ accountId: string; tabIds: string[]; ready: boolean }> = [];
        const { useWorkspaceState } = await import('./useWorkspaceState');
        const hook = await renderHook(() => {
            const result = useWorkspaceState({ initialTab, windowId: 'window-a' });
            observed.push({ accountId: storageState.scope.accountId, tabIds: Object.keys(result.state.tabs), ready: result.isReady });
            return result;
        });
        expect(hook.getCurrent().state.tabs['session-a']).toBeTruthy();

        storageState.scope = { serverId: 'home', accountId: 'bob' };
        await hook.rerender(undefined);
        expect(observed.filter((entry) => entry.accountId === 'bob').every((entry) => !entry.tabIds.includes('session-a'))).toBe(true);
        expect(hook.getCurrent().state.tabs.new).toBeTruthy();
        expect(saveLayouts).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
