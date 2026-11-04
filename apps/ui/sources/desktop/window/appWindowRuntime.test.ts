import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceState, reduceWorkspaceState, type WorkspaceAction } from '@/components/appShell/workspace/workspaceState';
import { workspaceLayoutsState } from '@/sync/domains/state/filePaneUiState';
import { serializeWorkspaceLayout, workspaceLayoutScopeKey } from '@/components/appShell/workspace/workspacePersistence';
import { registerMountedTabUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import type { DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { appPaneReduce, createAppPaneState, type AppPaneAction } from '@/components/appShell/panes/model/appPaneReducer';
import { closePaneDetailsWindowGroup } from '@/components/appShell/panes/paneTabWindowTransfer';
import { DesktopWindowsOpenInputSchema } from '@happier-dev/protocol/actions/actionSpecs';

const host = vi.hoisted(() => ({
    invoke: vi.fn(),
    listen: vi.fn(),
    availability: vi.fn(async (): Promise<{ windows: { kind: 'available' } | { kind: 'unavailable'; reason: string } }> => ({ windows: { kind: 'available' } })),
    events: new Map<string, (payload: unknown) => void>(),
}));
// The real lifecycle and workspace owner run beneath the native IPC boundary.
vi.mock('@/utils/platform/desktopHost', () => ({
    desktopHostKind: () => 'tauri',
    isDesktopHost: () => true,
    getDesktopHostWindowLabel: () => 'main',
    getDesktopHostAvailability: host.availability,
    invokeDesktopHost: host.invoke,
    listenDesktopHostEvent: host.listen,
}));

import {
    openDesktopAppWindow, registerDesktopAppWindowWorkspace, getDesktopAppWindowTransfers,
    resolveDesktopAppWindowForAction, getDesktopAppWindowPlacedTabs, getDesktopAppWindowTabPresentations, subscribeDesktopAppWindows,
    waitForDesktopAppWindowPresentation,
    focusDesktopAppWindowTab, returnDesktopAppWindowTab, closeDesktopAppWindowTab,
    retargetDesktopPaneWindow,
} from './appWindowRuntime';

afterEach(() => { vi.clearAllMocks(); host.events.clear(); });

function mountWorkspace(onRestoreError?: (error: unknown) => void, target: DestinationRef = { kind: 'session', params: {
        id: 'session', serverId: 'home', accountId: 'account',
    } }) {
    let state = createWorkspaceState({ id: 'tab', target, pinned: false, preview: false });
    const activated: string[] = [];
    const dispatch = (action: WorkspaceAction) => { state = reduceWorkspaceState(state, action); };
    const dispose = registerDesktopAppWindowWorkspace({ windowId: 'main-layout',
        scope: { serverId: 'home', accountId: 'account' }, getState: () => state, dispatch,
        catalog: [], activateTab: tabId => { activated.push(tabId); }, placementMetrics: { cascadeOffset: 24, screenInset: 24 }, onRestoreError,
    });
    return { read: () => state, activated, dispose };
}

describe('desktop app-window lifecycle', () => {
    it('routes a generic current-context read to the focused full view only within its Home and Account', async () => {
        host.listen.mockImplementation(async () => () => {});
        host.invoke.mockResolvedValue([{ windowId: 'focused-full', homeId: 'home', accountId: 'account', sessionId: 'session', focused: true }]);
        const { observeDesktopAppWindowSurfaces } = await import('./appWindowSurface');
        const stop = await observeDesktopAppWindowSurfaces();
        try {
            const action = { actionId: 'ui.current_context.read' as const, input: {}, serverId: 'home', accountId: 'account' };
            expect(resolveDesktopAppWindowForAction(action)).toBe('destination_focused-full');
            expect(resolveDesktopAppWindowForAction({ ...action, serverId: 'other-home' })).toBeNull();
            expect(resolveDesktopAppWindowForAction({ ...action, accountId: 'other-account' })).toBeNull();
            expect(resolveDesktopAppWindowForAction({ ...action, actionId: 'ui.voice_global.get', defaultSessionId: 'session' })).toBeNull();
        } finally { stop(); }
    });

    it('creates independent full views without moving the source, then focuses only the addressed view', async () => {
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        const opened = new Set<string>();
        host.invoke.mockImplementation(async (command: string, args: { activeOnly?: boolean; record?: { windowId: string } }) => {
            if (command === 'desktop_app_window_restore') return [];
            if (command === 'desktop_app_window_placement') return { frame: null, previousFrame: null, workArea: null };
            if (command === 'desktop_app_window_open' && args.record) {
                const reused = opened.has(args.record.windowId); opened.add(args.record.windowId);
                return { windowId: args.record.windowId, ready: true, reused };
            }
        });
        const owner = mountWorkspace();
        const initial = owner.read();
        try {
            const input = DesktopWindowsOpenInputSchema.parse({ chrome: 'full', target: {
                kind: 'session', serverId: 'home', accountId: 'account', sessionId: 'session',
            } });
            const first = await openDesktopAppWindow(input);
            const second = await openDesktopAppWindow(input);
            expect(first.status).toBe('opened'); expect(second.status).toBe('opened');
            expect('windowId' in first && 'windowId' in second && first.windowId !== second.windowId).toBe(true);
            expect(owner.read()).toBe(initial);
            expect(getDesktopAppWindowPlacedTabs()).toEqual([]);
            if (!('windowId' in first)) throw new Error('full window did not open');
            expect(await openDesktopAppWindow({ ...input, windowId: first.windowId })).toEqual({ status: 'focused', windowId: first.windowId });
            expect(opened.size).toBe(2);
            const writes = host.invoke.mock.calls.filter(([command]) => command === 'desktop_app_window_open');
            expect(writes).toHaveLength(3);
            expect(writes[0][1].record).toMatchObject({ chrome: 'full', layoutId: first.windowId });
            expect(writes[0][1].record.sourceTabId).toBeUndefined();
        } finally { host.events.get('desktopAppWindow://records')?.([]); owner.dispose(); }
    });

    it('opens a blank full Home and restores each saved full layout exactly once', async () => {
        const saved = [{ windowId: 'full-a', chrome: 'full', accountId: 'account', homeId: 'home', layoutId: 'layout-a', selectedAddress: { kind: 'home' } },
            { windowId: 'full-b', chrome: 'full', accountId: 'account', homeId: 'home-b', layoutId: 'layout-b', selectedAddress: { kind: 'home' } }];
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async (command: string, args: { activeOnly?: boolean; record?: { windowId: string } }) => {
            if (command === 'desktop_app_window_restore') return args.activeOnly ? [] : saved;
            if (command === 'desktop_app_window_placement') return { frame: null, previousFrame: null, workArea: null };
            if (command === 'desktop_app_window_open' && args.record) return { windowId: args.record.windowId, ready: true, reused: false };
        });
        const owner = mountWorkspace();
        try {
            const input = DesktopWindowsOpenInputSchema.parse({ chrome: 'full', target: { kind: 'home', accountId: 'account', serverId: 'home-c' } });
            expect((await openDesktopAppWindow(input)).status).toBe('opened');
            await vi.waitFor(() => expect(host.invoke.mock.calls.filter(([command]) => command === 'desktop_app_window_open')).toHaveLength(3));
            for (const record of saved) expect(host.invoke.mock.calls.filter(([command, args]) => command === 'desktop_app_window_open' && args.record.windowId === record.windowId)).toEqual([
                ['desktop_app_window_open', { record }],
            ]);
        } finally { host.events.get('desktopAppWindow://records')?.([]); owner.dispose(); }
    });

    it('does no native work or timer work merely by importing the lifecycle owner', () => {
        expect(host.invoke).not.toHaveBeenCalled();
        expect(host.listen).not.toHaveBeenCalled();
        expect(getDesktopAppWindowTransfers()).toEqual([]);
    });

    it.each([false, true])('commits a placed pane selection only after its old body departure is admitted: %s', async admitted => {
        const address = { kind: 'paneTab', serverId: 'home', accountId: 'account', layoutId: 'main-layout',
            scopeId: 'pane-scope', tabKey: 'right:slot' } as const;
        const selectedAddress = { kind: 'paneTab', layoutId: address.layoutId, scopeId: address.scopeId,
            tabKey: address.tabKey, resourceId: 'old-resource' } as const;
        const record = { windowId: 'pane-window', accountId: 'account', homeId: 'home', layoutId: 'pane-window', selectedAddress };
        const effects: string[] = [];
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async (command: string, args: { activeOnly?: boolean; payload?: {
            windowLabel: string; requestId: string;
        } }) => {
            if (command === 'desktop_app_window_restore') return args.activeOnly ? [record] : [];
            if (command === 'desktop_app_window_placement') return { frame: null, previousFrame: null, workArea: null };
            if (command === 'desktop_window_emit_action' && args.payload) {
                effects.push('departure');
                host.events.get('desktopWindow://action-result')?.({ windowLabel: args.payload.windowLabel,
                    requestId: args.payload.requestId, phase: 'settled', ok: admitted,
                    ...(admitted ? { result: { returned: true } } : { errorCode: 'cancelled', error: 'cancelled' }) });
            }
            if (command === 'desktop_app_window_open') return { windowId: record.windowId, ready: true, reused: true };
        });
        const owner = mountWorkspace();
        try {
            await waitForDesktopAppWindowPresentation({ input: {}, serverId: 'home', accountId: 'account' });
            expect(await retargetDesktopPaneWindow(address, () => {
                effects.push('selection');
                return { ...address, resourceId: 'new-resource' };
            })).toBe(admitted);
            expect(effects).toEqual(admitted ? ['departure', 'selection'] : ['departure']);
            const opened = host.invoke.mock.calls.filter(([command]) => command === 'desktop_app_window_open');
            if (admitted) expect(opened).toEqual([['desktop_app_window_open', expect.objectContaining({ record: {
                ...record, selectedAddress: { ...selectedAddress, resourceId: 'new-resource' },
            } })]]);
            else {
                expect(opened).toEqual([]);
                expect(host.invoke.mock.calls.some(([command]) => command === 'desktop_app_window_update')).toBe(false);
            }
        } finally { host.events.get('desktopAppWindow://records')?.([]); owner.dispose(); }
    });

    it('keeps the source pane group when the actual window body cancels group close', async () => {
        const scope = { serverId: 'home', accountId: 'account', layoutId: 'main-layout', scopeId: 'pane-scope' };
        const tabKey = 'file:/repo/dirty.ts';
        let paneState = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'openDetailsTab', scopeId: scope.scopeId,
            tab: { key: tabKey, kind: 'file', title: 'dirty.ts', resource: { path: '/repo/dirty.ts' } }, openAs: 'pinned' });
        paneState = appPaneReduce(paneState, { type: 'setDetailsTabPresentation', scopeId: scope.scopeId, tabKey,
            presentation: { windowId: 'dirty-pane' } });
        const original = paneState;
        const groupId = paneState.scopes[scope.scopeId].details.focusedGroupId!;
        const record = { windowId: 'dirty-pane', accountId: scope.accountId, homeId: scope.serverId, layoutId: 'dirty-pane',
            selectedAddress: { kind: 'paneTab', layoutId: scope.layoutId, scopeId: scope.scopeId, tabKey } };
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async (command: string, args: { activeOnly?: boolean; payload?: {
            windowLabel: string; requestId: string;
        } }) => {
            if (command === 'desktop_app_window_restore') return args.activeOnly ? [record] : [];
            if (command === 'desktop_window_emit_action' && args.payload) host.events.get('desktopWindow://action-result')?.({
                windowLabel: args.payload.windowLabel, requestId: args.payload.requestId, phase: 'settled', ok: false,
                errorCode: 'cancelled', error: 'cancelled',
            });
        });
        const owner = mountWorkspace();
        try {
            await waitForDesktopAppWindowPresentation({ input: {}, serverId: 'home', accountId: 'account' });
            expect(await closePaneDetailsWindowGroup({ getReadState: () => paneState,
                dispatch: (action: AppPaneAction) => { paneState = appPaneReduce(paneState, action); } }, scope, groupId)).toBe(false);
            expect(paneState).toBe(original);
            expect(host.invoke).toHaveBeenCalledWith('desktop_window_emit_action', expect.objectContaining({ payload: expect.objectContaining({
                actionIdentifier: 'desktop.window.return', targetWindowLabel: 'destination_dirty-pane', data: { intent: 'close' },
            }) }));
            expect(host.invoke.mock.calls.some(([command]) => command === 'desktop_app_window_close')).toBe(false);
        } finally { host.events.get('desktopAppWindow://records')?.([]); owner.dispose(); }
    });

    it('returns the qualified recipient destination when a different main tab has the same bare id', async () => {
        const record = { windowId: 'recipient', accountId: 'account', homeId: 'home', layoutId: 'recipient-layout',
            selectedAddress: { kind: 'destination', target: { kind: 'workflow', params: { id: 'recipient-workflow' } } } };
        const recipientKey = workspaceLayoutScopeKey({ serverId: 'home', accountId: 'account', windowId: record.layoutId });
        workspaceLayoutsState.set(recipientKey, serializeWorkspaceLayout(createWorkspaceState({ id: 'tab',
            target: record.selectedAddress.target, pinned: true, preview: false })));
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async (command: string, args: { activeOnly?: boolean; payload?: {
            windowLabel: string; requestId: string;
        } }) => {
            if (command === 'desktop_app_window_restore') return args.activeOnly ? [record] : [];
            if (command === 'desktop_window_emit_action' && args.payload) host.events.get('desktopWindow://action-result')?.({
                windowLabel: args.payload.windowLabel, requestId: args.payload.requestId, phase: 'settled', ok: true,
                result: { returned: true },
            });
        });
        const owner = mountWorkspace(undefined, { kind: 'workflow', params: { id: 'main-workflow' } });
        try {
            await waitForDesktopAppWindowPresentation({ input: {}, serverId: 'home', accountId: 'account' });
            expect(await returnDesktopAppWindowTab({ serverId: 'home', accountId: 'account', layoutId: record.layoutId, tabId: 'tab' })).toBe(true);
            expect(owner.read().tabs.tab.target).toEqual({ kind: 'workflow', params: { id: 'main-workflow' } });
            const returned = Object.values(owner.read().tabs).find(tab => tab.target.kind === 'workflow' && tab.target.params.id === 'recipient-workflow');
            expect(returned).toBeDefined();
            expect(returned?.id).not.toBe('tab');
            expect(owner.activated).toEqual([returned?.id]);
        } finally { host.events.get('desktopAppWindow://records')?.([]); workspaceLayoutsState.remove(recipientKey); owner.dispose(); }
    });

    it('moves a catalog tab through its retained layout and reflects native focus without creating Session state', async () => {
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async (command: string) => {
            if (command === 'desktop_app_window_restore') return [];
            if (command === 'desktop_app_window_placement') return { frame: null, previousFrame: null, workArea: null };
            if (command === 'desktop_app_window_open') return { windowId: 'catalog-window', ready: true, reused: false };
        });
        const owner = mountWorkspace(undefined, { kind: 'settings', params: { section: 'appearance' } });
        try {
            expect(await openDesktopAppWindow({ windowId: 'catalog-window', target: {
                kind: 'workspaceTab', serverId: 'home', accountId: 'account', tabId: 'tab',
            } })).toMatchObject({ status: 'opened', windowId: 'catalog-window' });
            expect(owner.read().tabs.tab.presentation).toEqual({ windowId: 'catalog-window' });
            expect(owner.read().groups['group:1'].tabIds).toEqual(['tab']);
            expect(await focusDesktopAppWindowTab({ serverId: 'home', accountId: 'account', layoutId: 'main-layout', tabId: 'tab' })).toBe(true);
            expect(await focusDesktopAppWindowTab({ serverId: 'home', accountId: 'account', layoutId: 'other-layout', tabId: 'tab' })).toBe(false);
            expect(await focusDesktopAppWindowTab({ serverId: 'home', accountId: 'other-account', layoutId: 'main-layout', tabId: 'tab' })).toBe(false);
            expect(host.invoke.mock.calls.filter(([command]) => command === 'desktop_app_window_open').map(([, args]) => args.record.selectedAddress))
                .toEqual([{ kind: 'workspaceTab', tabId: 'tab' }, { kind: 'workspaceTab', tabId: 'tab' }]);
            let publications = 0;
            const release = subscribeDesktopAppWindows(() => { publications++; });
            try {
                host.events.get('desktopAppWindow://lifecycle')?.({ kind: 'focused', windowId: 'catalog-window', focused: true });
                expect(getDesktopAppWindowTabPresentations()).toContainEqual(expect.objectContaining({ windowId: 'catalog-window', focused: true }));
                expect(publications).toBe(1);
                host.events.get('desktopAppWindow://lifecycle')?.({ kind: 'focused', windowId: 'catalog-window', focused: true });
                expect(publications, 'duplicate native focus must not publish').toBe(1);
                host.events.get('desktopAppWindow://lifecycle')?.({ kind: 'focused', windowId: 'catalog-window', focused: false });
                expect(getDesktopAppWindowTabPresentations()).toContainEqual(expect.objectContaining({ windowId: 'catalog-window', focused: false }));
                expect(publications).toBe(2);
                host.events.get('desktopAppWindow://lifecycle')?.({ kind: 'focused', windowId: 'catalog-window', focused: false });
                expect(publications, 'duplicate native blur must not publish').toBe(2);
            } finally { release(); }
        } finally { host.events.get('desktopAppWindow://records')?.([]); owner.dispose(); }
    });

    it.each(['keepEditing', 'failedSave'] as const)('keeps an unpersisted form editable when departure is %s', async decision => {
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async () => []);
        const owner = mountWorkspace(undefined, { kind: 'settings', params: { form: 'credentials' } });
        const dirty = { current: true };
        const releaseGuard = registerMountedTabUnsavedChangesGuard('tab', {
            isDirtyRef: dirty, requestDecision: async () => decision === 'keepEditing' ? 'keepEditing' : 'save',
            onSave: async () => false, tag: 'unpersisted-form',
        });
        try {
            expect(await openDesktopAppWindow({ target: { kind: 'workspaceTab', serverId: 'home', accountId: 'account', tabId: 'tab' } }))
                .toEqual({ status: 'cancelled' });
            expect(dirty.current).toBe(true);
            expect(owner.read().tabs.tab.presentation).toBeUndefined();
            expect(host.invoke.mock.calls.filter(([command]) => command === 'desktop_app_window_open')).toEqual([]);
        } finally { releaseGuard(); owner.dispose(); }
    });

    it('moves an unpersisted form after its existing Discard decision settles', async () => {
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async (command: string) => {
            if (command === 'desktop_app_window_restore') return [];
            if (command === 'desktop_app_window_placement') return { frame: null, previousFrame: null, workArea: null };
            if (command === 'desktop_app_window_open') return { windowId: 'discarded-form', ready: true, reused: false };
        });
        const owner = mountWorkspace(undefined, { kind: 'settings', params: { form: 'credentials' } });
        const dirty = { current: true };
        let discarded = false;
        const releaseGuard = registerMountedTabUnsavedChangesGuard('tab', {
            isDirtyRef: dirty, requestDecision: async () => 'discard',
            onDiscard: () => { discarded = true; }, tag: 'unpersisted-form',
        });
        try {
            expect(await openDesktopAppWindow({ windowId: 'discarded-form', target: {
                kind: 'workspaceTab', serverId: 'home', accountId: 'account', tabId: 'tab',
            } })).toMatchObject({ status: 'opened', windowId: 'discarded-form' });
            expect(discarded).toBe(true);
            expect(dirty.current).toBe(false);
            expect(owner.read().tabs.tab.presentation).toEqual({ windowId: 'discarded-form' });
        } finally { host.events.get('desktopAppWindow://records')?.([]); releaseGuard(); owner.dispose(); }
    });

    it('reuses and closes a no-source destination within its exact Home and Account without adding main tabs', async () => {
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        const nativeWindows = new Set<string>();
        host.invoke.mockImplementation(async (command: string, args: { record?: { windowId: string }; payload?: {
            windowLabel: string; requestId: string;
        } }) => {
            if (command === 'desktop_app_window_restore') return [];
            if (command === 'desktop_app_window_placement') return { frame: null, previousFrame: null, workArea: null };
            if (command === 'desktop_app_window_open' && args.record) {
                const reused = nativeWindows.has(args.record.windowId);
                nativeWindows.add(args.record.windowId);
                return { windowId: args.record.windowId, ready: true, reused };
            }
            if (command === 'desktop_window_emit_action' && args.payload) {
                host.events.get('desktopWindow://action-result')?.({ windowLabel: args.payload.windowLabel,
                    requestId: args.payload.requestId, phase: 'settled', ok: true, result: { returned: true } });
            }
        });
        const owner = mountWorkspace(undefined, { kind: 'settings', params: {} });
        const original = owner.read();
        try {
            const target = { kind: 'destination', href: '/workflows/shared-id', serverId: 'home', accountId: 'account' } as const;
            expect(await openDesktopAppWindow({ windowId: 'no-source', target })).toMatchObject({ status: 'opened', windowId: 'no-source' });
            expect(await openDesktopAppWindow({ windowId: 'ignored-window-id', target })).toMatchObject({ status: 'focused', windowId: 'no-source' });
            expect(await openDesktopAppWindow({ windowId: 'other-home', target: { ...target, serverId: 'another-home' } }))
                .toMatchObject({ status: 'opened', windowId: 'other-home' });
            expect(await openDesktopAppWindow({ windowId: 'other-account', target: { ...target, accountId: 'another-account' } }))
                .toMatchObject({ status: 'opened', windowId: 'other-account' });
            expect(owner.read()).toBe(original);
            expect(getDesktopAppWindowPlacedTabs()).toEqual([]);
            expect(host.invoke.mock.calls.filter(([command]) => command === 'desktop_app_window_open').map(([, args]) => args.record))
                .toEqual(expect.arrayContaining([expect.objectContaining({ windowId: 'no-source', homeId: 'home', accountId: 'account',
                    selectedAddress: { kind: 'destination', target: { kind: 'workflow', params: { id: 'shared-id' } } } })]));
            host.events.get('desktopAppWindow://lifecycle')?.({ kind: 'return', windowId: 'no-source' });
            await vi.waitFor(() => expect(host.invoke).toHaveBeenCalledWith('desktop_app_window_close', { windowId: 'no-source' }));
            expect(owner.read()).toBe(original);
        } finally { host.events.get('desktopAppWindow://records')?.([]); owner.dispose(); }
    });

    it('sets canonical placement only after ready and routes only the exact Account/Home Session', async () => {
        let created!: () => void;
        const creation = new Promise<void>(resolve => { created = resolve; });
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async (command: string) => {
            if (command === 'desktop_app_window_restore') return [];
            if (command === 'desktop_app_window_placement') return { workArea: { x: 0, y: 0, width: 1600, height: 1000 }, previousFrame: null, frame: null };
            if (command === 'desktop_app_window_open') { created(); return { windowId: 'window', windowLabel: 'destination_window', ready: false, reused: false }; }
            return undefined;
        });
        const workspace = mountWorkspace();
        const operation = openDesktopAppWindow({ target: { kind: 'workspaceTab', accountId: 'account', serverId: 'home', tabId: 'tab' }, windowId: 'window' });
        await creation;
        let writable = false;
        const edit = waitForDesktopAppWindowPresentation({ input: { sessionId: 'session' }, accountId: 'account', serverId: 'home' }).then(() => { writable = true; });
        await Promise.resolve();
        expect(writable).toBe(false);
        expect(workspace.read().tabs.tab.presentation).toBeUndefined();
        expect(getDesktopAppWindowTransfers()).toEqual(['tab']);
        host.events.get('desktopAppWindow://lifecycle')?.({ kind: 'ready', windowId: 'window' });
        expect(await operation).toMatchObject({ status: 'opened', windowId: 'window' });
        await edit;
        expect(writable).toBe(true);
        expect(workspace.read().tabs.tab.presentation).toEqual({ windowId: 'window' });
        expect(getDesktopAppWindowTransfers()).toEqual([]);
        expect(resolveDesktopAppWindowForAction({ actionId: 'session.draft.append', input: { sessionId: 'session' }, accountId: 'account', serverId: 'home' })).toBe('destination_window');
        expect(resolveDesktopAppWindowForAction({ actionId: 'session.draft.append', input: { sessionId: 'session' }, accountId: 'account', serverId: 'other-home' })).toBeNull();
        host.invoke.mockImplementation(async (command: string) => command === 'desktop_app_window_placement'
            ? { frame: null, previousFrame: null, workArea: null }
            : { windowId: 'window', windowLabel: 'destination_window', ready: true, reused: true });
        expect(await focusDesktopAppWindowTab({ tabId: 'tab', accountId: 'account', serverId: 'home' })).toBe(true);
        expect(await focusDesktopAppWindowTab({ tabId: 'tab', accountId: 'account', serverId: 'other-home' })).toBe(false);
        expect(await returnDesktopAppWindowTab({ tabId: 'missing', accountId: 'account', serverId: 'home' })).toBe(false);
        workspace.dispose();
    });

    it('rejects unavailable Windows hosts before creating a window or changing placement', async () => {
        host.availability.mockResolvedValueOnce({ windows: { kind: 'unavailable', reason: 'electron_overlay_unavailable' } });
        await expect(openDesktopAppWindow({ target: { kind: 'session', accountId: 'account', serverId: 'home', sessionId: 'session' } })).rejects.toMatchObject({ code: 'unsupported_action' });
        expect(host.invoke).not.toHaveBeenCalled();
    });

    it('returns a failed hidden recipient to its source instead of leaving the draft transfer waiting forever', async () => {
        let created!: () => void;
        const creation = new Promise<void>(resolve => { created = resolve; });
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async (command: string) => {
            if (command === 'desktop_app_window_restore') return [];
            if (command === 'desktop_app_window_placement') return { frame: null, workArea: null, previousFrame: null };
            if (command === 'desktop_app_window_open') { created(); return { windowId: 'broken', windowLabel: 'destination_broken', ready: false, reused: false }; }
        });
        const owner = mountWorkspace();
        const result = openDesktopAppWindow({ windowId: 'broken', target: { kind: 'workspaceTab', tabId: 'tab', serverId: 'home', accountId: 'account' } })
            .then(() => null, (error: unknown) => error);
        await creation;
        host.events.get('desktopAppWindow://lifecycle')?.({ kind: 'failed', windowId: 'broken', error: 'presentation_unavailable' });
        await vi.waitFor(() => expect(host.invoke).toHaveBeenCalledWith('desktop_app_window_close', { windowId: 'broken' }));
        expect(await result).toMatchObject({ message: 'presentation_unavailable' });
        expect(owner.read().tabs.tab.presentation).toBeUndefined();
        expect(getDesktopAppWindowTransfers()).toEqual([]);
        owner.dispose();
    });

    it.each<{ selectedAddress: import('./appWindowBoot').AppWindowAddress; target: DestinationRef }>([
        { selectedAddress: { kind: 'session', sessionId: 'session' }, target: { kind: 'session', params: { id: 'session' } } },
        { selectedAddress: { kind: 'workspaceTab', tabId: 'tab' }, target: { kind: 'settings', params: { pageId: 'appearance' } } },
    ])('recreates saved $selectedAddress.kind windows with their Home and retained source layout', async ({ selectedAddress, target }) => {
        const saved = { windowId: 'restored', accountId: 'account', homeId: 'home', layoutId: 'saved-layout',
            sourceLayoutId: 'main-layout', sourceTabId: 'tab', selectedAddress };
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async (command: string, args: { activeOnly?: boolean }) => {
            if (command === 'desktop_app_window_restore') return args.activeOnly ? [] : [saved];
            if (command === 'desktop_app_window_placement') return { frame: null, previousFrame: null, workArea: null };
            if (command === 'desktop_app_window_open') return { windowId: 'restored', windowLabel: 'destination_restored', ready: true, reused: false };
            return undefined;
        });
        const owner = mountWorkspace(undefined, target);
        await vi.waitFor(() => expect(host.invoke).toHaveBeenCalledWith('desktop_app_window_open', { record: saved }));
        expect(owner.read().tabs.tab.presentation).toEqual({ windowId: 'restored' });
        owner.dispose();
    });

    it('projects shown source tabs from the native record set with exact Home and Account identity', async () => {
        let subscribed!: () => void;
        const subscription = new Promise<void>(resolve => { subscribed = resolve; });
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler);
            if (event === 'desktopAppWindow://records') subscribed();
            return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async () => []);
        const owner = mountWorkspace();
        await vi.waitFor(() => expect(host.events.has('desktopAppWindow://records')).toBe(true));
        await subscription;
        host.events.get('desktopAppWindow://records')?.([
            { windowId: 'one', accountId: 'account', homeId: 'home', layoutId: 'one', sourceLayoutId: 'main', sourceTabId: 'tab', selectedAddress: { kind: 'session', sessionId: 'session' } },
            { windowId: 'two', accountId: 'account', homeId: 'other-home', layoutId: 'two', sourceLayoutId: 'full', sourceTabId: 'tab', selectedAddress: { kind: 'session', sessionId: 'session' } },
        ]);
        expect(getDesktopAppWindowPlacedTabs()).toEqual([
            { windowId: 'one', serverId: 'home', accountId: 'account', layoutId: 'main', tabId: 'tab' },
            { windowId: 'two', serverId: 'other-home', accountId: 'account', layoutId: 'full', tabId: 'tab' },
        ]);
        host.events.get('desktopAppWindow://records')?.([]);
        expect(getDesktopAppWindowPlacedTabs()).toEqual([]);
        owner.dispose();
    });

    it('waits for native startup placement before admitting an edit to a retained window', async () => {
        let resolveSnapshot!: (records: unknown[]) => void;
        const snapshot = new Promise<unknown[]>(resolve => { resolveSnapshot = resolve; });
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async (command: string, args: { activeOnly?: boolean }) => command === 'desktop_app_window_restore'
            ? args.activeOnly ? snapshot : [] : undefined);
        const owner = mountWorkspace();
        let admitted = false;
        const edit = waitForDesktopAppWindowPresentation({ input: { sessionId: 'session' }, serverId: 'home', accountId: 'account' })
            .then(() => { admitted = true; });
        await Promise.resolve();
        expect(admitted).toBe(false);
        resolveSnapshot([{ windowId: 'retained', accountId: 'account', homeId: 'home', layoutId: 'retained',
            selectedAddress: { kind: 'session', sessionId: 'session' } }]);
        await edit;
        expect(resolveDesktopAppWindowForAction({ input: { sessionId: 'session' }, serverId: 'home', accountId: 'account' }))
            .toBe('destination_retained');
        host.events.get('desktopAppWindow://records')?.([]);
        owner.dispose();
    });

    it('focuses the existing exact target instead of stealing it into an explicitly retargeted window', async () => {
        const record = { windowId: 'original', accountId: 'account', homeId: 'home', layoutId: 'original',
            sourceLayoutId: 'another-layout', sourceTabId: 'original-tab', selectedAddress: { kind: 'session', sessionId: 'session' } };
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async (command: string, args: { activeOnly?: boolean; record?: typeof record }) => {
            if (command === 'desktop_app_window_restore') return args.activeOnly ? [record] : [];
            if (command === 'desktop_app_window_placement') return { frame: null, previousFrame: null, workArea: null };
            if (command === 'desktop_app_window_open') return { windowId: args.record?.windowId, ready: true, reused: true };
        });
        const owner = mountWorkspace();
        await vi.waitFor(() => expect(resolveDesktopAppWindowForAction({ input: { sessionId: 'session' }, serverId: 'home', accountId: 'account' })).toBe('destination_original'));
        expect(await openDesktopAppWindow({ windowId: 'other-window', target: { kind: 'session', sessionId: 'session', serverId: 'home', accountId: 'account' } }))
            .toMatchObject({ status: 'focused', windowId: 'original' });
        expect(host.invoke).toHaveBeenCalledWith('desktop_app_window_open', { record });
        expect(owner.read().tabs.tab.presentation).toBeUndefined();
        host.events.get('desktopAppWindow://records')?.([]);
        owner.dispose();
    });

    it('restores independent windows without waiting for an offline recipient to become ready', async () => {
        const saved = ['offline', 'online'].map(windowId => ({ windowId, accountId: 'account', homeId: 'home', layoutId: windowId,
            selectedAddress: { kind: 'session', sessionId: windowId } }));
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async (command: string, args: { activeOnly?: boolean; record?: typeof saved[number] }) => {
            if (command === 'desktop_app_window_restore') return args.activeOnly ? [] : saved;
            if (command === 'desktop_app_window_placement') return { frame: null, previousFrame: null, workArea: null };
            if (command === 'desktop_app_window_open') return { windowId: args.record?.windowId, ready: args.record?.windowId === 'online', reused: false };
        });
        const owner = mountWorkspace();
        await vi.waitFor(() => expect(host.invoke).toHaveBeenCalledWith('desktop_app_window_open', { record: saved[1] }));
        host.events.get('desktopAppWindow://lifecycle')?.({ kind: 'ready', windowId: 'offline' });
        await vi.waitFor(() => expect(resolveDesktopAppWindowForAction({ input: { sessionId: 'offline' }, serverId: 'home', accountId: 'account' })).toBe('destination_offline'));
        host.events.get('desktopAppWindow://records')?.([]);
        owner.dispose();
    });

    it('closes only a dormant source after its window retargets to another Session', async () => {
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async (command: string) => {
            if (command === 'desktop_window_emit_action') throw new Error('unexpected mounted-body close');
            return [];
        });
        const scope = { accountId: 'account', serverId: 'other-home' };
        const key = workspaceLayoutScopeKey({ ...scope, windowId: 'full-source' });
        const bodyKey = workspaceLayoutScopeKey({ ...scope, windowId: 'retargeted' });
        let source = createWorkspaceState({ id: 'earlier', target: { kind: 'session', params: { id: 'earlier-session' } }, pinned: true, preview: false });
        for (const id of ['current', 'other']) source = reduceWorkspaceState(source, { type: 'openTab', groupId: 'group:1',
            tab: { id, target: { kind: 'session', params: { id: `${id}-session` } }, pinned: true, preview: false } });
        for (const tabId of ['earlier', 'current', 'other']) source = reduceWorkspaceState(source, {
            type: 'setPresentation', tabId, presentation: { windowId: 'retargeted' },
        });
        workspaceLayoutsState.set(key, serializeWorkspaceLayout(source));
        workspaceLayoutsState.set(bodyKey, serializeWorkspaceLayout(createWorkspaceState({ id: 'body',
            target: { kind: 'session', params: { id: 'current-session' } }, pinned: true, preview: false })));
        const owner = mountWorkspace();
        await vi.waitFor(() => expect(host.events.has('desktopAppWindow://records')).toBe(true));
        host.events.get('desktopAppWindow://records')?.([{ windowId: 'retargeted', accountId: 'account', homeId: 'other-home',
            layoutId: 'retargeted', sourceLayoutId: 'full-source', sourceTabId: 'current', selectedAddress: { kind: 'session', sessionId: 'current-session' } }]);
        expect(await closeDesktopAppWindowTab({ ...scope, tabId: 'earlier' })).toBe(true);
        const saved = workspaceLayoutsState.read(key) as typeof source;
        expect(saved.tabs.earlier.presentation).toBeUndefined();
        expect(saved.tabs.current.presentation).toEqual({ windowId: 'retargeted' });
        expect(saved.tabs.other.presentation).toEqual({ windowId: 'retargeted' });
        expect(saved.groups).toEqual(source.groups);
        expect(getDesktopAppWindowPlacedTabs()).toContainEqual({ ...scope, layoutId: 'full-source', windowId: 'retargeted', tabId: 'current' });
        expect(host.invoke.mock.calls.some(([command]) => command === 'desktop_window_emit_action' || command === 'desktop_app_window_close')).toBe(false);
        host.events.get('desktopAppWindow://records')?.([]);
        workspaceLayoutsState.remove(key);
        workspaceLayoutsState.remove(bodyKey);
        owner.dispose();
    });

    it.each(['placement', 'open', 'readiness'])('retains a failed restore and retries with its saved placement after %s failure', async phase => {
        const record = { windowId: 'restore-failure', accountId: 'account', homeId: 'home', layoutId: 'restore-failure',
            sourceLayoutId: 'main-layout', sourceTabId: 'tab', selectedAddress: { kind: 'session', sessionId: 'session' } };
        const failure = new Error('native_window_unavailable');
        const reported = vi.fn();
        let retained = [record];
        let fail = true;
        const frame = { x: 20, y: 30, width: 800, height: 600 };
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async (command: string, args: { activeOnly?: boolean; reason?: string }) => {
            if (command === 'desktop_app_window_restore') return args.activeOnly ? [] : retained;
            if (command === 'desktop_app_window_close' && args.reason !== 'restoreFailed') retained = [];
            if (command === 'desktop_app_window_placement') {
                if (fail && phase === 'placement') throw failure;
                return { frame, previousFrame: null, workArea: null };
            }
            if (command === 'desktop_app_window_open') {
                if (fail && phase === 'open') throw failure;
                if (fail && phase === 'readiness') {
                    queueMicrotask(() => host.events.get('desktopAppWindow://lifecycle')?.({ kind: 'failed', windowId: record.windowId, error: failure.message }));
                    return { windowId: record.windowId, ready: false, reused: false };
                }
                return { windowId: record.windowId, ready: true, reused: false };
            }
        });
        const owner = mountWorkspace(reported);
        try {
        await vi.waitFor(() => expect(reported).toHaveBeenCalledWith(expect.objectContaining({ message: failure.message }), expect.any(Function)));
        expect(host.invoke).toHaveBeenCalledWith('desktop_app_window_close', { windowId: record.windowId, reason: 'restoreFailed' });
        expect(retained).toEqual([record]);
        expect(owner.read().tabs.tab.presentation).toBeUndefined();
        expect(getDesktopAppWindowTransfers()).toEqual([]);
        fail = false;
        reported.mock.calls[0][1]();
        await vi.waitFor(() => expect(owner.read().tabs.tab.presentation).toEqual({ windowId: record.windowId }));
        expect(host.invoke).toHaveBeenLastCalledWith('desktop_app_window_open', { record, frame });
        } finally { host.events.get('desktopAppWindow://records')?.([]); owner.dispose(); }
    });

    it('clears canonical placement when destruction arrives before the native record snapshot', async () => {
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async (command: string) => {
            if (command === 'desktop_app_window_restore') return [];
            if (command === 'desktop_app_window_placement') return { frame: null, previousFrame: null, workArea: null };
            if (command === 'desktop_app_window_open') return { windowId: 'destroyed-first', windowLabel: 'destination_destroyed-first',
                ready: true, reused: false };
        });
        const owner = mountWorkspace();
        await openDesktopAppWindow({ windowId: 'destroyed-first', target: { kind: 'workspaceTab', tabId: 'tab', serverId: 'home', accountId: 'account' } });
        expect(owner.read().tabs.tab.presentation).toEqual({ windowId: 'destroyed-first' });
        host.events.get('desktopAppWindow://lifecycle')?.({ kind: 'destroyed', windowId: 'destroyed-first' });
        host.events.get('desktopAppWindow://records')?.([]);
        expect(owner.read().tabs.tab.presentation).toBeUndefined();
        expect(resolveDesktopAppWindowForAction({ input: { sessionId: 'session' }, serverId: 'home', accountId: 'account' })).toBeNull();
        owner.dispose();
    });

    it('reports native Close failure and resumes the existing presenting window', async () => {
        const saved = { windowId: 'close-failure', accountId: 'account', homeId: 'home', layoutId: 'close-layout',
            selectedAddress: { kind: 'session', sessionId: 'session' } };
        const failure = new Error('native close refused');
        const onRestoreError = vi.fn();
        let nativeCloseReached!: () => void;
        const nativeClose = new Promise<void>(resolve => { nativeCloseReached = resolve; });
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async (command: string, args?: { payload?: {
            actionIdentifier: string; windowLabel: string; requestId: string;
        } }) => {
            if (command === 'desktop_app_window_restore') return [saved];
            if (command === 'desktop_window_emit_action' && args?.payload) {
                const request = args.payload;
                host.events.get('desktopWindow://action-result')?.({ windowLabel: request.windowLabel,
                    requestId: request.requestId, phase: 'settled', ok: true,
                    result: request.actionIdentifier === 'desktop.window.return' ? { returned: true } : { resumed: true } });
            }
            if (command === 'desktop_app_window_close') { nativeCloseReached(); throw failure; }
        });
        const owner = mountWorkspace(onRestoreError);
        await waitForDesktopAppWindowPresentation({ input: {}, serverId: 'home', accountId: 'account' });
        host.events.get('desktopAppWindow://lifecycle')?.({ kind: 'return', windowId: saved.windowId });
        await nativeClose;
        await vi.waitFor(() => expect(onRestoreError).toHaveBeenCalledWith(failure));
        expect(host.invoke).toHaveBeenCalledWith('desktop_window_emit_action', expect.objectContaining({
            payload: expect.objectContaining({ actionIdentifier: 'desktop.window.resume', targetWindowLabel: 'destination_close-failure' }),
        }));
        expect(resolveDesktopAppWindowForAction({ input: { sessionId: 'session' }, serverId: 'home', accountId: 'account' }))
            .toBe('destination_close-failure');
        host.events.get('desktopAppWindow://records')?.([]);
        owner.dispose();
    });

    it('keeps a source placement qualified to its source Home after retargeting the window to another Home', async () => {
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async () => []);
        const key = workspaceLayoutScopeKey({ serverId: 'source-home', accountId: 'account', windowId: 'source-layout' });
        const source = createWorkspaceState({ id: 'source', target: { kind: 'session', params: { id: 'source-session' } }, pinned: false, preview: false });
        workspaceLayoutsState.set(key, serializeWorkspaceLayout(reduceWorkspaceState(source, { type: 'setPresentation', tabId: 'source', presentation: { windowId: 'cross-home' } })));
        const owner = mountWorkspace();
        await vi.waitFor(() => expect(host.events.has('desktopAppWindow://records')).toBe(true));
        host.events.get('desktopAppWindow://records')?.([{ windowId: 'cross-home', accountId: 'account', homeId: 'destination-home', layoutId: 'cross-home',
            sourceLayoutId: 'source-layout', sourceTabId: 'source', selectedAddress: { kind: 'session', sessionId: 'destination-session' } }]);
        expect(getDesktopAppWindowPlacedTabs()).toEqual([{ windowId: 'cross-home', serverId: 'source-home', accountId: 'account', layoutId: 'source-layout', tabId: 'source' }]);
        host.events.get('desktopAppWindow://records')?.([]);
        workspaceLayoutsState.remove(key);
        owner.dispose();
    });

    it('retains earlier source placements across retarget and clears them from their original layout on close', async () => {
        host.listen.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            host.events.set(event, handler); return () => host.events.delete(event);
        });
        host.invoke.mockImplementation(async () => []);
        const key = workspaceLayoutScopeKey({ accountId: 'account', serverId: 'other-home', windowId: 'full-source' });
        const original = createWorkspaceState({ id: 'earlier', target: { kind: 'session', params: { id: 'earlier-session' } }, pinned: false, preview: false });
        workspaceLayoutsState.set(key, serializeWorkspaceLayout(reduceWorkspaceState(original, { type: 'setPresentation', tabId: 'earlier', presentation: { windowId: 'retargeted' } })));
        const owner = mountWorkspace();
        await vi.waitFor(() => expect(host.events.has('desktopAppWindow://records')).toBe(true));
        host.events.get('desktopAppWindow://records')?.([
            { windowId: 'retargeted', accountId: 'account', homeId: 'other-home', layoutId: 'retargeted', sourceLayoutId: 'full-source', sourceTabId: 'current', selectedAddress: { kind: 'session', sessionId: 'current-session' } },
        ]);
        expect(getDesktopAppWindowPlacedTabs()).toContainEqual({ windowId: 'retargeted', serverId: 'other-home', accountId: 'account', layoutId: 'full-source', tabId: 'earlier' });
        host.events.get('desktopAppWindow://records')?.([]);
        expect(workspaceLayoutsState.read(key)).toMatchObject({ tabs: { earlier: { id: 'earlier' } } });
        expect((workspaceLayoutsState.read(key) as typeof original).tabs.earlier.presentation).toBeUndefined();
        expect((workspaceLayoutsState.read(key) as typeof original).groups).toEqual(original.groups);
        workspaceLayoutsState.remove(key);
        owner.dispose();
    });
});
