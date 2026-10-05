import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { resolveCompactAppDestinations, type CompactAppDestination } from '../destinations/compactAppDestinationCatalog';
import { WorkspaceProvider } from './WorkspaceProvider';
import { usePhoneWorkspaceTabs, type PhoneWorkspaceTabs } from './usePhoneWorkspaceTabs';
import { useOptionalWorkspaceNavigation } from './WorkspaceNavigationContext';
import { projectWorkspaceSharedTabs } from './workspaceSyncedTabs';
import { useWorkspaceOpenActions, WORKSPACE_OPEN_IN_NEW_TAB_ID } from './useWorkspaceOpenActions';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { serializeWorkspaceLayout, workspaceLayoutScopeKey } from './workspacePersistence';
import { clearActiveUnsavedChangesGuard, setActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { invokeWorkspaceAction } from './workspaceActionRuntime';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storage';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionNavigationCursor } from '@/sync/domains/session/navigation/sessionNavigationCursor';
import { clearSessionNavigationCursor, publishSessionNavigationCursor } from '@/sync/domains/session/navigation/sessionNavigationCursorStore';
import { buildServerScopedSessionKey } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { useSessionSwitcher, type SessionSwitcher } from '@/components/navigation/mobile/chrome/lateralSwipe/useSessionSwitcher';
import { readSessionAllTabs } from '@/components/sessions/shell/useSessionAllTabsOpener';
import { SessionSwitcherBand } from '@/components/navigation/mobile/chrome/lateralSwipe/SessionSwitcherBand';
import { readReanimatedFrameCallbacks, resetReanimatedFrameCallbacks } from '@/dev/testkit/mocks/reanimated';
import { findGestureByKind, type TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';
import { resetSessionSwitcherStateForTests, useSessionSwitcherState } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { SESSION_SWITCHER_ROW_HEIGHT } from '@/components/navigation/mobile/chrome/lateralSwipe/sessionSwitcherPanelLayout';

const boundary = vi.hoisted(() => ({
    layouts: {} as Record<string, unknown>,
    pathname: '/session/A1',
    params: { serverId: 'home-a', mobileSurface: 'git' } as Record<string, string>,
    pushes: [] as string[],
    replaces: [] as string[],
}));
// Socket transport is a genuine boundary; no credentials means no tab-sync RPC should run.
vi.mock('@/sync/api/session/apiSocket', () => ({ apiSocket: {} }));
// This navigation journey never renders Markdown; the vendor/native SDK remains a boundary.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected vendor Markdown reveal in workspace navigation test'); },
}));
// This harness has no recipient-envelope HTTP/process authority; reaching that API is a setup bug.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in workspace navigation test'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});
// Authentication is a boundary of this no-network layout harness, not a lifecycle under test.
vi.mock('@/auth/context/AuthContext', () => ({
    useOptionalAuth: () => null,
    useAuth: () => ({ refreshFromActiveServer: async () => {} }),
    InjectedAuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('react-native-worklets', () => ({ scheduleOnRN: (callback: (...args: unknown[]) => unknown, ...args: unknown[]) => queueMicrotask(() => callback(...args)) }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native-safe-area-context', () => {
    const insets = { top: 0, bottom: 0, left: 0, right: 0 };
    const frame = { x: 0, y: 0, width: 390, height: 844 };
    const passthrough = ({ children }: { children: React.ReactNode }) => children;
    return { useSafeAreaInsets: () => insets, useSafeAreaFrame: () => frame, initialWindowMetrics: { insets, frame },
        SafeAreaProvider: passthrough, SafeAreaView: passthrough, SafeAreaInsetsContext: React.createContext(insets), SafeAreaFrameContext: React.createContext(frame) };
});
// Native phones have no browser History; Expo's stack is the platform navigation boundary.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default },
        useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }) });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => boundary.pathname, params: () => boundary.params, router: {
        push: (href: unknown) => { boundary.pushes.push(String(href)); },
        replace: (href: unknown) => { boundary.replaces.push(String(href)); },
    } }).module;
});
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const { create } = await import('zustand');
    const baseline = createStorageModuleStub({});
    const store = create<ReturnType<typeof baseline.storage.getState>>(() => ({ ...baseline.storage.getState(), settings: baseline.useSettings() }));
    return createStorageModuleStub({
    storage: store,
    getStorage: () => store,
    useSetting: (key: keyof ReturnType<typeof baseline.useSettings>) => store.getState().settings[key],
    useIsDataReady: () => true,
    useActiveServerAccountScope: () => ({ serverId: 'home-a', accountId: 'alice' }),
    useLocalSettingMutable: (key: string) => {
        if (key !== 'workspaceLayoutV1') throw new Error(`Unexpected setting ${key}`);
        // The workspace layout setting is the only device-local value this owner reads.
        return [boundary.layouts, (next: Record<string, unknown>) => { boundary.layouts = next; }] as never;
    },
    });
});

const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
    externalSessions: false, inbox: false, workflows: false, friends: false,
} });

function Probe() {
    const tabs = usePhoneWorkspaceTabs();
    const workspace = useOptionalWorkspaceNavigation();
    const rowMenu = useWorkspaceOpenActions('/session/B7?serverId=home-a');
    return React.createElement('PhoneTabs', { tabs, workspace, rowMenu });
}

function SwitcherProbe() {
    const switcher = useSessionSwitcher({ sessionId: 'B', serverId: 'home-a' });
    const phoneTabs = usePhoneWorkspaceTabs();
    const shared = useSessionSwitcherState();
    return React.createElement('SwitcherProbe', { switcher, phoneTabs, shared });
}

let restoreStorage: (() => void) | null = null;

describe('workspace owner on a phone', () => {
    afterEach(() => {
        boundary.layouts = {}; boundary.pathname = '/session/A1'; boundary.params = { serverId: 'home-a', mobileSurface: 'git' };
        boundary.pushes = []; boundary.replaces = []; standardCleanup();
        clearActiveUnsavedChangesGuard();
        clearSessionNavigationCursor();
        restoreStorage?.(); restoreStorage = null;
        resetSessionSwitcherStateForTests(); resetReanimatedFrameCallbacks();
    });

    const render = () => renderScreen(<WorkspaceProvider enabled={false} phone catalog={catalog}><Probe /></WorkspaceProvider>);
    const read = (screen: Awaited<ReturnType<typeof render>>) => screen.root.findByType('PhoneTabs').props as {
        tabs: PhoneWorkspaceTabs; workspace: NonNullable<ReturnType<typeof useOptionalWorkspaceNavigation>>;
        rowMenu: ReturnType<typeof useWorkspaceOpenActions>;
    };
    const rows = (tabs: PhoneWorkspaceTabs) => tabs.tabs.map((tab) => tab.panes.map((pane) =>
        `${pane.target.kind}:${pane.target.params.id ?? ''}${pane.preview ? ' (preview)' : ''}`).join('+'));

    it('activates the exact same-destination instance in its split group before the route echo', async () => {
        const tab = (id: string) => ({ id, target: { kind: 'session', params: { id: 'A1', serverId: 'home-a' } }, pinned: false, preview: false });
        let saved = createWorkspaceState(tab('first'));
        const groupId = saved.focusedGroupId;
        saved = reduceWorkspaceState(saved, { type: 'openTab', groupId, tab: tab('second') });
        saved = reduceWorkspaceState(saved, { type: 'splitTab', tabId: 'second', sourceGroupId: groupId, targetGroupId: groupId,
            newGroupId: 'other', axis: 'row', placement: 'after', availableSizePx: 1600, minimumFirstSizePx: 320, minimumSecondSizePx: 320 });
        saved = reduceWorkspaceState(saved, { type: 'activateTab', groupId, tabId: 'first' });
        boundary.layouts = { [workspaceLayoutScopeKey({ serverId: 'home-a', accountId: 'alice', windowId: 'main' })]: saved };
        const screen = await render();
        await act(async () => { read(screen).tabs.activate('second'); });
        expect(read(screen).workspace.state.focusedGroupId).toBe('other');
        expect(read(screen).workspace.state.groups.other.activeTabId).toBe('second');
        expect(boundary.replaces).toEqual(['/session/A1?serverId=home-a']);
    });

    it('keeps tab membership and focus unchanged when a phone open or close is declined', async () => {
        const screen = await render();
        const before = read(screen).workspace.state;
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision: async () => 'keepEditing', tag: 'phone-test' });
        await act(async () => { read(screen).workspace.phone?.openHref('/session/A3?serverId=home-a', 'newTab'); });
        expect(read(screen).workspace.state).toBe(before);
        await act(async () => { read(screen).tabs.close(before.groups[before.focusedGroupId].activeTabId); });
        expect(read(screen).workspace.state).toBe(before);
        expect(boundary.replaces).toEqual([]);
    });

    it.each(['Action', 'tab control'] as const)('can return from All tabs to the already focused exact tab through the phone %s owner', async (entry) => {
        const screen = await render();
        const tabId = read(screen).workspace.state.groups[read(screen).workspace.state.focusedGroupId].activeTabId;
        await act(async () => { read(screen).tabs.activate(tabId); });
        boundary.pathname = '/all-tabs'; boundary.params = {};
        await act(async () => { screen.update(<WorkspaceProvider enabled={false} phone catalog={catalog}><Probe /></WorkspaceProvider>); });
        boundary.pushes = [];
        await act(async () => {
            if (entry === 'Action') expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.activate', input: { tabId } })).toEqual({ ok: true });
            else read(screen).tabs.activate(tabId);
        });
        expect(boundary.pushes).toEqual(['/session/A1?serverId=home-a']);
    });

    it('projects active close to the survivor and final close to the list through mounted phone Actions', async () => {
        const screen = await render();
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.open', input: { href: '/session/A3?serverId=home-a', mode: 'newTab' } })).toEqual({ ok: true });
        });
        const state = () => read(screen).workspace.state;
        const first = Object.values(state().tabs).find(tab => tab.target.params.id === 'A1')!.id;
        const kept = state().groups[state().focusedGroupId].activeTabId;
        boundary.pathname = '/session/A3'; boundary.params = { serverId: 'home-a' };
        await act(async () => { screen.update(<WorkspaceProvider enabled={false} phone catalog={catalog}><Probe /></WorkspaceProvider>); });
        await act(async () => { expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.close', input: { tabId: kept } })).toEqual({ ok: true }); });
        expect(boundary.replaces.at(-1)).toBe('/session/A1?serverId=home-a');
        await act(async () => { expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.close', input: { tabId: first } })).toEqual({ ok: true }); });
        expect(boundary.replaces.at(-1)).toBe('/');
        const before = state();
        await act(async () => { expect(await invokeWorkspaceAction({ actionId: 'workspace.split', input: { direction: 'right' } })).toMatchObject({ ok: false }); });
        expect(state()).toBe(before);
        await screen.unmount();
        expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.list', input: {} })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    });

    const renderSwitcher = async (mru: string[], up: 'list' | 'recent', side: 'list' | 'recent', band = false) => {
        const before = storage.getState();
        restoreStorage = () => storage.setState(before);
        const entries = ['A', 'B', 'C'].map(id => ({ type: 'session', serverId: 'home-a', sessionId: id }));
        storage.setState({ settings: { ...before.settings, sessionSwitcherDragUpSource: up, sessionCockpitSwipeSource: side },
            localSettings: { ...before.localSettings, sessionMruOrderV1: mru },
            sessionListRowsByServerId: { 'home-a': Object.fromEntries(['A', 'B', 'C'].map(id => [id, createSessionListRenderableSessionFixture({ id })])) } });
        publishSessionNavigationCursor(buildSessionNavigationCursor({ identity: { origin: 'session-list', sourceScopeKey: 'home-a', storageKind: 'all' }, items: entries, nowMs: 0 })!);
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><WorkspaceProvider enabled={false} phone catalog={catalog}>
            {band ? <SessionSwitcherBand sessionId="B" serverId="home-a"><SwitcherProbe /></SessionSwitcherBand> : <SwitcherProbe />}
        </WorkspaceProvider></InjectedAuthProvider>);
        const readSwitcher = () => screen.root.findByType('SwitcherProbe').props as { switcher: SessionSwitcher; phoneTabs: PhoneWorkspaceTabs };
        return { screen, readSwitcher };
    };

    it('reveals rows reached by stationary edge-hold frame advancement', async () => {
        const order = ['B', ...Array.from({ length: 15 }, (_, index) => `older-${index}`)];
        const { screen } = await renderSwitcher(order.map(id => `home-a:${id}`), 'recent', 'list', true);
        const before = storage.getState();
        await act(async () => { storage.setState({ sessionListRowsByServerId: { 'home-a': Object.fromEntries(order.map(id => [id, createSessionListRenderableSessionFixture({ id })])) } }); });
        const pan = findGestureByKind(screen.root.findAllByType('GestureDetector')[0].props.gesture as TestGestureChain, 'pan')!;
        await act(async () => {
            pan.__handlers.onBegin();
            pan.__handlers.onStart({ translationX: 0, translationY: -15, absoluteY: 829 });
            pan.__handlers.onUpdate({ translationX: 0, translationY: -120, absoluteY: 724 });
        });
        await act(async () => {
            pan.__handlers.onUpdate({ translationX: 0, translationY: -800, absoluteY: 0 });
        });
        const shared = screen.root.findByType('SwitcherProbe').props.shared as ReturnType<typeof useSessionSwitcherState>;
        shared.index.value = 0; shared.scroll.value = 0;
        const frame = readReanimatedFrameCallbacks().find(record => record.handle.isActive)!;
        await act(async () => { frame.run({ timestamp: 1000, timeSincePreviousFrame: 1000, timeSinceFirstFrame: 1000 }); });
        expect(shared.index.value).toBeGreaterThan(5);
        expect(shared.scroll.value).toBeGreaterThan(0);
        const panel = screen.root.find(node => Array.isArray(node.props.layout?.rowBottoms) && typeof node.props.viewportHeight === 'number');
        const rowBottom = panel.props.layout.rowBottoms[shared.index.value] as number;
        expect(rowBottom - shared.scroll.value).toBeGreaterThanOrEqual(0);
        expect(rowBottom + SESSION_SWITCHER_ROW_HEIGHT - shared.scroll.value).toBeLessThanOrEqual(panel.props.viewportHeight);
        storage.setState(before);
    });

    it('reads genuine 0.2 MRU keys in both switcher and All tabs through the navigation normalizer', async () => {
        const { readSwitcher } = await renderSwitcher(['home-a:B', 'home-a:C', 'home-a:A'], 'recent', 'list');
        expect(readSwitcher().switcher.prepare().rows.up.map(row => row.target.kind === 'session' ? row.target.sessionId : '')).toEqual(['C', 'A']);
        expect(readSessionAllTabs({ session: { sessionId: 'B', serverId: 'home-a' }, phoneTabs: readSwitcher().phoneTabs }).sections.flatMap(section => section.rows)
            .map(row => row.target.kind === 'session' ? row.target.sessionId : '')).toEqual(['B', 'C', 'A']);
    });

    it('walks the vertical list source for flicks while sideways independently uses recent order', async () => {
        const key = (id: string) => buildServerScopedSessionKey(id, 'home-a');
        const { readSwitcher } = await renderSwitcher(['B', 'A', 'C'].map(key), 'list', 'recent');
        const switcher = readSwitcher().switcher;
        expect(switcher.prepare().rows.next[0]?.target).toMatchObject({ sessionId: 'A' });
        const result: { row: ReturnType<SessionSwitcher['flick']> } = { row: null };
        await act(async () => { result.row = switcher.flick('next'); });
        expect(result.row?.target).toMatchObject({ sessionId: 'C' });
    });

    it('opens a session switcher row by its retained tab instance', async () => {
        const { screen, readSwitcher } = await renderSwitcher([], 'recent', 'list');
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.open', input: { href: '/session/B?serverId=home-a', mode: 'newTab' } })).toEqual({ ok: true });
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.open', input: { href: '/session/C?serverId=home-a', mode: 'newTab' } })).toEqual({ ok: true });
        });
        const row = readSwitcher().switcher.prepare().rows.up.find(row => row.target.kind === 'session' && row.target.sessionId === 'C')!;
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.activate', input: { tabId: readSwitcher().phoneTabs.tabs.find(tab => tab.session?.sessionId === 'B')!.id } })).toEqual({ ok: true });
            readSwitcher().switcher.open(row);
        });
        const workspace = screen.root.findByType('SwitcherProbe').props.phoneTabs as PhoneWorkspaceTabs;
        expect(workspace.activeTabId).toBe(row.target.kind === 'session' ? row.target.tabId : null);
    });

    it.each(['catalog', 'explicit'] as const)('keeps unknown-route hydration read-only without losing an explicit phone open: %s', async (arrival) => {
        boundary.pathname = '/plugins/acme.notes/notes'; boundary.params = {};
        const layouts = boundary.layouts;
        const screen = await render();
        expect(boundary.layouts).toBe(layouts);
        if (arrival === 'catalog') {
            const page = { id: 'acme.notes.notes', kind: 'plugin', container: 'appPage',
            destination: { pluginId: 'acme.notes', localId: 'notes' }, title: 'Notes', icon: 'file',
                order: 40, placement: { kind: 'rail', region: 'plugins' }, activation: 'navigate',
                availability: 'available', routePath: '/plugins/acme.notes/notes' } satisfies CompactAppDestination;
            await act(async () => {
                screen.update(<WorkspaceProvider enabled={false} phone catalog={[...catalog, page]}><Probe /></WorkspaceProvider>);
            });
            expect(read(screen).tabs.tabs.flatMap(tab => tab.panes).some(pane => pane.target.kind === page.id)).toBe(true);
            expect(boundary.layouts).toBe(layouts);
        }
        await act(async () => {
            expect(read(screen).workspace.phone?.openHref('/session/A3?serverId=home-a', 'newTab')).toBe(true);
        });
        expect(boundary.layouts).not.toBe(layouts);
        expect(Object.values(boundary.layouts)[0]).toEqual(serializeWorkspaceLayout(read(screen).workspace.state));
        await screen.unmount();
    });

    it('persists explicit activation of a restored phone tab before the initial route is admitted', async () => {
        boundary.pathname = '/plugins/acme.notes/notes'; boundary.params = {};
        const tab = (id: string) => ({ id, target: { kind: 'session', params: { id, serverId: 'home-a' } }, pinned: false, preview: false });
        const initial = createWorkspaceState(tab('A1'));
        const groupId = initial.focusedGroupId;
        const opened = reduceWorkspaceState(initial, { type: 'openTab', groupId, tab: tab('A2') });
        const saved = reduceWorkspaceState(opened, { type: 'activateTab', groupId, tabId: 'A1' });
        boundary.layouts = { [workspaceLayoutScopeKey({ serverId: 'home-a', accountId: 'alice', windowId: 'main' })]: saved };
        const layouts = boundary.layouts;
        const screen = await render();
        await act(async () => { read(screen).tabs.activate('A2'); });
        boundary.pathname = '/session/A2'; boundary.params = { serverId: 'home-a' };
        await act(async () => { screen.update(<WorkspaceProvider enabled={false} phone catalog={catalog}><Probe /></WorkspaceProvider>); });
        expect(read(screen).workspace.state.groups[groupId].activeTabId).toBe('A2');
        expect(boundary.layouts).not.toBe(layouts);
        expect(Object.values(boundary.layouts)[0]).toEqual(serializeWorkspaceLayout(read(screen).workspace.state));
        await screen.unmount();
    });

    it('shows what the phone opened as its one preview tab, never synced and never taking over the stack', async () => {
        const screen = await render();
        expect(read(screen).tabs.available).toBe(true);
        expect(read(screen).workspace.active).toBe(false);
        // The tool on screen is the phone's presentation, not the tab's identity.
        expect(rows(read(screen).tabs)).toEqual(['session:A1 (preview)']);
        expect(read(screen).tabs.activeTabId).toBe(read(screen).tabs.tabs[0].id);

        boundary.pathname = '/session/A2'; boundary.params = { serverId: 'home-a' };
        await act(async () => { screen.update(<WorkspaceProvider enabled={false} phone catalog={catalog}><Probe /></WorkspaceProvider>); });
        expect(rows(read(screen).tabs)).toEqual(['session:A2 (preview)']);

        // The Sessions list is the phone's own main tab, not something to keep open.
        boundary.pathname = '/'; boundary.params = {};
        await act(async () => { screen.update(<WorkspaceProvider enabled={false} phone catalog={catalog}><Probe /></WorkspaceProvider>); });
        expect(rows(read(screen).tabs)).toEqual(['session:A2 (preview)']);
        expect(read(screen).tabs.activeTabId).toBeNull();

        expect(projectWorkspaceSharedTabs(read(screen).workspace.state).order).toEqual([]);
        expect(boundary.replaces).toEqual([]);
        expect(boundary.pushes).toEqual([]);
    });

    it('keeps "Open in new tab" as a synced tab, switches tabs without history, and closes through the owner', async () => {
        boundary.pathname = '/'; boundary.params = {};
        const screen = await render();
        const rerender = async (pathname: string, params: Record<string, string>) => {
            boundary.pathname = pathname; boundary.params = params;
            await act(async () => { screen.update(<WorkspaceProvider enabled={false} phone catalog={catalog}><Probe /></WorkspaceProvider>); });
        };
        expect(rows(read(screen).tabs)).toEqual([]);
        // From the list (a main tab) the open pushes, so Back returns to the list.
        await act(async () => {
            expect(read(screen).workspace.phone?.openHref('/session/A3?serverId=home-a', 'newTab')).toBe(true);
        });
        expect(boundary.pushes).toEqual(['/session/A3?serverId=home-a']);
        await rerender('/session/A3', { serverId: 'home-a' });
        expect(rows(read(screen).tabs)).toEqual(['session:A3']);
        const shared = projectWorkspaceSharedTabs(read(screen).workspace.state);
        expect(shared.order.map((id) => shared.tabsById[id].target.params.id)).toEqual(['A3']);

        // Something opened without "new tab" is the preview, last in the rail.
        await rerender('/session/A1', { serverId: 'home-a', mobileSurface: 'chat' });
        expect(rows(read(screen).tabs)).toEqual(['session:A3', 'session:A1 (preview)']);
        const kept = read(screen).tabs.tabs[0];
        await act(async () => { read(screen).tabs.activate(kept.id); });
        // A tab switch replaces the screen: Back still leads to the list.
        expect(boundary.replaces).toEqual(['/session/A3?serverId=home-a']);

        await act(async () => { read(screen).tabs.close(kept.id); });
        expect(rows(read(screen).tabs)).toEqual(['session:A1 (preview)']);
        expect(projectWorkspaceSharedTabs(read(screen).workspace.state).order).toEqual([]);
    });

    it('offers a session row exactly "Open in new tab" on a phone (splits need a canvas the phone does not have)', async () => {
        boundary.pathname = '/'; boundary.params = {};
        const screen = await render();
        expect(read(screen).rowMenu.items.map((item) => item.id)).toEqual([WORKSPACE_OPEN_IN_NEW_TAB_ID]);
        await act(async () => { expect(read(screen).rowMenu.select(WORKSPACE_OPEN_IN_NEW_TAB_ID)).toBe(true); });
        expect(boundary.pushes).toEqual(['/session/B7?serverId=home-a']);
        expect(rows(read(screen).tabs)).toEqual(['session:B7']);
    });
});
