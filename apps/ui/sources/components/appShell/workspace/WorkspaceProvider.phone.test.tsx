import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { CompactAppDestination } from '../destinations/compactAppDestinationCatalog';
import type { PhoneWorkspaceTabs } from './usePhoneWorkspaceTabs';
import { projectWorkspaceSharedTabs } from './workspaceSyncedTabs';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { serializeWorkspaceLayout, workspaceLayoutScopeKey } from './workspacePersistence';
import { clearActiveUnsavedChangesGuard, setActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionNavigationCursor } from '@/sync/domains/session/navigation/sessionNavigationCursor';
import { clearSessionNavigationCursor, publishSessionNavigationCursor } from '@/sync/domains/session/navigation/sessionNavigationCursorStore';
import { buildServerScopedSessionKey } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { sessionMruState } from '@/sync/domains/session/navigation/recentSessions';
import type { SessionSwitcher } from '@/components/navigation/mobile/chrome/lateralSwipe/useSessionSwitcher';
import type { WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { readReanimatedFrameCallbacks, resetReanimatedFrameCallbacks } from '@/dev/testkit/mocks/reanimated';
import { findGestureByKind, type TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';
import { SESSION_SWITCHER_ROW_HEIGHT } from '@/components/navigation/mobile/chrome/lateralSwipe/sessionSwitcherPanelLayout';

const boundary = vi.hoisted(() => ({
    layouts: {} as Record<string, unknown>,
    pathname: '/session/A1',
    params: { serverId: 'home-a', mobileSurface: 'git' } as Record<string, string>,
    pushes: [] as string[],
    replaces: [] as string[],
}));
const { workspaceLayoutsState } = await import('@/sync/domains/state/filePaneUiState');
Object.defineProperty(boundary, 'layouts', {
    get: () => workspaceLayoutsState.readAll(),
    set: (layouts: Record<string, unknown>) => {
        for (const key of Object.keys(workspaceLayoutsState.readAll())) workspaceLayoutsState.remove(key);
        for (const [key, layout] of Object.entries(layouts)) workspaceLayoutsState.set(key, layout);
    },
});
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// This navigation journey never renders Markdown; the vendor/native SDK remains a boundary.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected vendor Markdown reveal in workspace navigation test'); },
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
        Dimensions: { get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }), addEventListener: () => ({ remove: () => {} }) },
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
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const { clearPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
const { resolveCompactAppDestinations } = await import('../destinations/compactAppDestinationCatalog');
const { WorkspaceProvider } = await import('./WorkspaceProvider');
const { usePhoneWorkspaceTabs } = await import('./usePhoneWorkspaceTabs');
const { useOptionalWorkspaceNavigation } = await import('./WorkspaceNavigationContext');
const { useWorkspaceOpenActions, WORKSPACE_OPEN_IN_NEW_TAB_ID } = await import('./useWorkspaceOpenActions');
const { invokeWorkspaceAction } = await import('./workspaceActionRuntime');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { useSessionSwitcher } = await import('@/components/navigation/mobile/chrome/lateralSwipe/useSessionSwitcher');
const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
const { readSessionAllTabs } = await import('@/components/sessions/shell/useSessionAllTabsOpener');
const { SessionSwitcherBand } = await import('@/components/navigation/mobile/chrome/lateralSwipe/SessionSwitcherBand');
const { resetSessionSwitcherStateForTests, useSessionSwitcherState } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
const initialStorage = storage.getState();

const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
    externalSessions: false, inbox: false, workflows: false, friends: false,
} });

function Probe() {
    const tabs = usePhoneWorkspaceTabs(null);
    const workspace = useOptionalWorkspaceNavigation();
    const rowMenu = useWorkspaceOpenActions('/session/B7?serverId=home-a');
    return React.createElement('PhoneTabs', { tabs, workspace, rowMenu });
}

function SwitcherProbe() {
    const switcher = useSessionSwitcher({ sessionId: 'B', serverId: 'home-a' });
    const phoneTabs = usePhoneWorkspaceTabs(null);
    const shared = useSessionSwitcherState();
    return React.createElement('SwitcherProbe', { switcher, phoneTabs, shared });
}

let restoreStorage: (() => void) | null = null;

describe('workspace owner on a phone', () => {
    beforeEach(async () => {
        clearPersistenceStorage();
        installHomeGovernanceBoundaries(homes);
        await homes.addHome({ name: 'Phone workspace', serverUrl: 'https://home-a', accountId: null });
        const scope = { serverId: 'home-a', accountId: 'alice' };
        storage.setState({ ...initialStorage, profileScope: scope, settingsScope: scope, isDataReady: true }, true);
    });

    afterEach(async () => {
        standardCleanup();
        setScreenSharingPrivacyActive(false);
        boundary.layouts = {}; boundary.pathname = '/session/A1'; boundary.params = { serverId: 'home-a', mobileSurface: 'git' };
        boundary.pushes = []; boundary.replaces = [];
        clearActiveUnsavedChangesGuard();
        clearSessionNavigationCursor();
        restoreStorage?.(); restoreStorage = null;
        resetSessionSwitcherStateForTests(); resetReanimatedFrameCallbacks();
        await homes.reset();
        storage.setState(initialStorage, true);
    });

    const render = () => renderScreen(<WorkspaceProvider enabled={false} phone catalog={catalog}><Probe /></WorkspaceProvider>);
    const read = (screen: Awaited<ReturnType<typeof render>>) => screen.root.findByType('PhoneTabs').props as {
        tabs: PhoneWorkspaceTabs; workspace: WorkspaceNavigationContextValue;
        rowMenu: ReturnType<typeof useWorkspaceOpenActions>;
    };
    const rows = (tabs: PhoneWorkspaceTabs) => tabs.tabs.map((tab) => tab.panes.map((pane) =>
        `${pane.target.kind}:${pane.target.params.id ?? ''}${pane.preview ? ' (preview)' : ''}`).join('+'));

    it('keeps Project phone chrome page and Shell presses in the retained pane across reload', async () => {
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const serverUrl = 'https://project-phone-navigation.test';
        const serverId = await homes.addHome({ name: 'Project phone navigation', serverUrl, accountId: 'alice', currentAccount: true });
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
        if (!credentials) throw new Error('Expected saved Project phone credentials');
        const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', credentials, request: homes.request });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState(current => ({ settingsScope: { serverId, accountId: 'alice' }, profileScope: { serverId, accountId: 'alice' },
            settings: { ...current.settings, mobileWorkspaceExperienceV1: 'cockpit' } }));
        boundary.pathname = '/projects/wr_1/terminal';
        boundary.params = { serverId };
        const tab = { id: 'shell-pane', target: { kind: 'project', params: { workspaceRefId: 'wr_1', pageId: 'terminal', serverId } }, pinned: false, preview: false };
        const saved = createWorkspaceState(tab);
        boundary.layouts = { [workspaceLayoutScopeKey({ serverId, accountId: 'alice', windowId: 'main' })]: saved };
        const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
        const { MobileBottomChromeHost } = await import('@/components/navigation/mobile/chrome/MobileBottomChromeHost');
        const { useSetting } = await import('@/sync/domains/state/storage');
        const { useDeviceType } = await import('@/utils/platform/responsive');
        const { usePathname } = await import('./destinationRoute');
        const { AppPaneProvider } = await import('../panes/AppPaneProvider');
        const { AppShellPluginUiProjectionProvider } = await import('../plugins/AppShellPluginUiProjection');
        const { DestinationInstanceHost } = await import('./DestinationInstanceHost');
        const { ProjectPageCatalogProvider } = await import('@/components/projects/navigation/useProjectPageCatalog');
        const { applyProjectAccountRowsFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const project = { id: 'wr_1', serverId, machineId: 'project-machine', rootPath: '/repo', projectKey: 'phone-project', createdAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [project] });
        function ChromeFacts() {
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            return React.createElement('ChromeFixtureFacts', { experience: useSetting('mobileWorkspaceExperienceV1'), deviceType: useDeviceType(), pathname: usePathname(),
                actionReady: binding?.isCurrent() === true });
        }
        const mount = () => renderScreen(<InjectedAuthProvider credentials={credentials}>
            <AppPaneProvider><AppShellPluginUiProjectionProvider><MainAppTabStateProvider><WorkspaceProvider enabled={false} phone catalog={catalog}>
                {navigation => {
                    const tabId = navigation.state.groups[navigation.state.focusedGroupId].activeTabId;
                    const selected = navigation.state.tabs[tabId];
                    return <><Probe /><ChromeFacts />
                        <DestinationInstanceHost tabId={tabId} ref={selected.target}
                            pathname={`/projects/wr_1/${selected.target.params.pageId ?? 'overview'}`}
                            visible focused phone navigation={navigation.navigationForTab(tabId)}>
                            <ProjectPageCatalogProvider workspaceRef={project} activeRootPath={project.rootPath}>{null}</ProjectPageCatalogProvider>
                        </DestinationInstanceHost>
                        <MobileBottomChromeHost />
                    </>;
                }}
            </WorkspaceProvider></MainAppTabStateProvider></AppShellPluginUiProjectionProvider></AppPaneProvider>
        </InjectedAuthProvider>);
        let screen = await mount();
        try {
            const current = () => read(screen).workspace.state;
            const projectChrome = () => screen.root.findAll(node => node.props.workspaceRefId === 'wr_1'
                && typeof node.props.onPagePress === 'function' && typeof node.props.onSurfacePress === 'function').at(-1)!;
            expect(screen.root.findByType('ChromeFixtureFacts').props).toMatchObject({ experience: 'cockpit', deviceType: 'phone', pathname: '/projects/wr_1/terminal' });
            await act(async () => { projectChrome().props.onPagePress('overview'); });
            await vi.waitFor(() => expect(current().tabs['shell-pane'].target.params.pageId).toBe('overview'));
            expect(Object.keys(current().tabs)).toEqual(['shell-pane']);
            const overviewRoute = new URL(boundary.replaces.at(-1)!, 'https://phone-navigation.test');
            boundary.pathname = overviewRoute.pathname;
            boundary.params = Object.fromEntries(overviewRoute.searchParams);
            await screen.unmount();
            screen = await mount();
            await vi.waitFor(() => expect(screen.root.findByType('ChromeFixtureFacts').props.actionReady).toBe(true));
            expect(Object.keys(current().tabs)).toEqual(['shell-pane']);
            expect(current().groups[current().focusedGroupId].activeTabId).toBe('shell-pane');
            await act(async () => { projectChrome().props.onSurfacePress('terminal'); });
            await vi.waitFor(() => expect(current().tabs['shell-pane'].target.params).toMatchObject({
                pageId: 'overview', mobileSurface: 'terminal',
            }));
            expect(Object.keys(current().tabs)).toEqual(['shell-pane']);
        } finally {
            await screen.unmount();
            await connection.dispose();
        }
    });

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
        sessionMruState.set('order', mru);
        storage.setState({ settings: { ...before.settings, sessionSwitcherDragUpSource: up, sessionCockpitSwipeSource: side },
            sessionListRowsByServerId: { 'home-a': Object.fromEntries(['A', 'B', 'C'].map(id => [id, createSessionListRenderableSessionFixture({ id })])) } });
        publishSessionNavigationCursor(buildSessionNavigationCursor({ identity: { origin: 'session-list', sourceScopeKey: 'home-a', storageKind: 'all' }, items: entries, nowMs: 0 })!);
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><WorkspaceProvider enabled={false} phone catalog={catalog}>
            {band ? <SessionSwitcherBand sessionId="B" serverId="home-a"><SwitcherProbe /></SessionSwitcherBand> : <SwitcherProbe />}
        </WorkspaceProvider></InjectedAuthProvider>);
        const readSwitcher = () => screen.root.findByType('SwitcherProbe').props as { switcher: SessionSwitcher; phoneTabs: PhoneWorkspaceTabs };
        return { screen, readSwitcher };
    };

    it('filters private Sessions from list and MRU switcher paths and restores them after sharing', async () => {
        const { readSwitcher } = await renderSwitcher(['home-a:B', 'home-a:C', 'home-a:A'], 'recent', 'list');
        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings, sessionListHiddenTagIdsWhileRecording: { 'home-a': ['private'] } } });
            storage.getState().setSessionTagAssignmentsOptimistic('home-a', 'C', ['private']);
            setScreenSharingPrivacyActive(true);
        });
        const ids = (mode: 'up' | 'next') => readSwitcher().switcher.prepare().rows[mode].map(row => row.target.kind === 'session' ? row.target.sessionId : '');
        expect(ids('up')).toEqual(['A']);
        expect(ids('next')).toEqual([]);
        await act(async () => { setScreenSharingPrivacyActive(false); });
        expect(ids('up')).toEqual(['C', 'A']);
        expect(ids('next')).toEqual(['C']);
    });

    it('removes a private Session from an already open switcher panel when sharing starts', async () => {
        const { screen } = await renderSwitcher(['home-a:B', 'home-a:C', 'home-a:A'], 'recent', 'list', true);
        const pan = findGestureByKind(screen.root.findAllByType('GestureDetector')[0].props.gesture as TestGestureChain, 'pan')!;
        await act(async () => {
            pan.__handlers.onBegin();
            pan.__handlers.onStart({ translationX: 0, translationY: -15, absoluteY: 829 });
            pan.__handlers.onUpdate({ translationX: 0, translationY: -120, absoluteY: 724 });
        });
        const panelIds = () => {
            const panel = screen.root.find(node => Array.isArray(node.props.layout?.rowBottoms) && typeof node.props.viewportHeight === 'number');
            return panel.props.layout.items.flatMap((item: { kind: string; row?: { target: { sessionId?: string } } }) => item.kind === 'row' ? [item.row?.target.sessionId] : []);
        };
        expect(panelIds()).toContain('C');
        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings, sessionListHiddenTagIdsWhileRecording: { 'home-a': ['private'] } } });
            storage.getState().setSessionTagAssignmentsOptimistic('home-a', 'C', ['private']);
            setScreenSharingPrivacyActive(true);
        });
        expect(panelIds()).not.toContain('C');
        await act(async () => { setScreenSharingPrivacyActive(false); });
        expect(panelIds()).toContain('C');
    });

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
        await act(async () => { storage.setState(before); });
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

        // This no-Account layout harness exercises the already admitted mounted transport;
        // human close admission is composed with real Account policy in WorkspaceTabs.seam.
        await act(async () => { expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.close', input: { tabId: kept.id } })).toEqual({ ok: true }); });
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
