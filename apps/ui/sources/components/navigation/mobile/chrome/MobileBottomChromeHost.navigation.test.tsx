import { resolveSessionCockpitMobileCatalog } from '@/components/workspaceCockpit/session/sessionCockpitMobileCatalog';
import { normalizeSessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
const mountedCatalog = resolveSessionCockpitMobileCatalog({ terminalTabAvailable: true });
function columnReader(switchSurface: (surface: import('@/components/workspaceCockpit/session/sessionCockpitState').SessionMobileSurface) => void) {
    return () => ({ present: true, visible: true, available: true, tabs: mountedCatalog.map(entry => entry.id),
        selectTab: (id: string) => { const surface = normalizeSessionMobileSurface(id); if (surface) switchSurface(surface); }, setVisible: () => {} });
}
import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';

const route = vi.hoisted(() => ({ params: {} as Record<string, string>, replace: vi.fn() }));
const viewport = vi.hoisted(() => ({ width: 1440, listeners: new Set<() => void>() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: () => '/session/resize-session', params: () => route.params,
    router: { replace: (href: unknown) => route.replace(href) },
}).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: React.useSyncExternalStore(
        listener => { viewport.listeners.add(listener); return () => viewport.listeners.delete(listener); },
        () => viewport.width,
    ), height: 844, scale: 1, fontScale: 1 }),
    Dimensions: { get: () => ({ width: viewport.width, height: 844, scale: 1, fontScale: 1 }) },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const runtime = installSessionPaneRuntimeTestHarness({ sessionId: 'resize-session', request: async (url) => (
    new URL(String(url)).pathname === '/v1/kv/bulk' ? Response.json({ values: [] }) : null
) });
const { storage } = await import('@/sync/domains/state/storageStore');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { useWindowDimensions } = await import('react-native');
const { MainAppTabStateProvider } = await import('./MainAppTabStateProvider');
const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
const { PresentedSessionChromeFixture } = await import('@/dev/testkit/harness/presentedDetailChrome');
const { SessionCockpitTabBar } = await import('./bars/SessionCockpitTabBar');
const { SessionCockpitChromeRegistryProvider, useSessionCockpitChromeRegister } = await import(
    '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry'
);
const { resolveSessionMobileSurfaceIntent } = await import('@/components/workspaceCockpit/session/sessionCockpitState');
const { createSessionScmReviewDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
const { applySessionPaneUrlState, buildActiveDetailsRouteParams, parseSessionPaneUrlState } = await import(
    '@/components/sessions/panes/url/sessionPaneUrlState'
);
const { useSessionPaneUrlSync } = await import('@/components/sessions/panes/url/useSessionPaneUrlSync');
const { WorkspaceNavigationProvider } = await import('@/components/appShell/workspace/WorkspaceNavigationContext');
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
const { createWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { MainAppTabBar } = await import('./bars/MainAppTabBar');
const { InboxSummaryProvider } = await import('@/hooks/inbox/useInboxSummary');
const stayOnSurface = () => {};

function PaneRouteSelection(props: Readonly<{ params: Record<string, string> }>) {
    const pane = useAppPaneScope('session:resize-session');
    const urlState = React.useMemo(() => parseSessionPaneUrlState(props.params), [props.params]);
    useSessionPaneUrlSync({ enabled: true, browserMirrorsEnabled: false, scopeKey: 'session:resize-session',
        pane, scopeState: pane.scopeState, urlState, setParams: null });
    return null;
}

/**
 * The cockpit's registration as SessionCockpitSurfaceScreen makes it: none while wide (no surface navigation), and on a
 * phone the focused scene first (Chat, where the navigator lands) and then the surface the route's pane intent asks for.
 */
function CockpitSelection() {
    const pane = useAppPaneScope('session:resize-session');
    const register = useSessionCockpitChromeRegister();
    const phone = useWindowDimensions().width <= 390;
    const [consumed, setConsumed] = React.useState(false);
    React.useEffect(() => setConsumed(phone), [phone]);
    const activeSurface = consumed ? resolveSessionMobileSurfaceIntent({
        routeKind: 'index', detailsTargetPresent: pane.scopeState?.details.isOpen,
    }) : 'chat';
    React.useEffect(() => phone ? register({ sessionId: 'resize-session', serverId: runtime.serverId,
        activeSurface, catalog: mountedCatalog, readColumn: columnReader(stayOnSurface), terminalTabAvailable: false, openDetailsTabCount: pane.scopeState?.details.tabs.length ?? 0,
        switchSurface: stayOnSurface,
    }) : undefined, [activeSurface, pane.scopeState?.details.tabs.length, phone, register]);
    return null;
}

it('keeps what a Session tab is across a 1440→390→1440 crossing: the cockpit presents its pane on the phone without a route write', async () => {
    // The route is the workspace tab's identity (WorkspaceProvider accepts every URL change into the focused tab).
    // Projecting the root URL's pane intent onto `/session/<id>/details?details=…` would turn this Session tab into
    // a lone Details link tab, which is what it stays when the window widens again.
    viewport.width = 1440;
    route.replace.mockClear();
    storage.setState(state => ({ settings: { ...state.settings, mobileWorkspaceExperienceV1: 'cockpit' } }));
    const tab = createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree', comparisonId: 'pending' }, view: 'walkthrough' });
    route.params = { ...buildActiveDetailsRouteParams([tab], tab.key), serverId: runtime.serverId };
    const expected = parseSessionPaneUrlState(route.params);
    if (!expected) throw new Error('Expected a canonical comparison pane URL');
    const screen = await renderScreen(<runtime.Wrapper><MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
        <CockpitSelection /><PresentedSessionChromeFixture /><MobileBottomChromeHost />
    </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider></runtime.Wrapper>);
    await act(async () => applySessionPaneUrlState(runtime.pane, expected));
    const paneBefore = runtime.pane.scopeState?.details;
    await act(async () => { viewport.width = 390; for (const listener of viewport.listeners) listener(); });
    await act(async () => { viewport.width = 1440; for (const listener of viewport.listeners) listener(); });
    expect(route.replace).not.toHaveBeenCalled();
    expect(runtime.pane.scopeState?.details).toEqual(paneBefore);
    await screen.unmount();
});

it.each([
    { pane: 'right', explicitChat: false },
    { pane: 'bottom', explicitChat: false },
    { pane: 'bottom', explicitChat: true },
])('sends Chat to the mounted owner from a resized $pane-terminal route, including an already-selected Chat (explicit Chat: $explicitChat)', async ({ pane, explicitChat }) => {
    viewport.width = 390;
    route.replace.mockClear();
    route.params = { serverId: runtime.serverId, [pane]: 'terminal', ...(explicitChat ? { mobileSurface: 'chat' } : {}) };
    storage.setState(state => ({ settings: { ...state.settings, mobileWorkspaceExperienceV1: 'cockpit' } }));
    const selections: string[] = [];
    function TerminalSelection() {
        const register = useSessionCockpitChromeRegister();
        const [surface, switchSurface] = React.useState<'chat' | 'terminal'>(explicitChat ? 'chat' : 'terminal');
        React.useEffect(() => register({ sessionId: 'resize-session', serverId: runtime.serverId,
            activeSurface: surface, catalog: mountedCatalog, readColumn: columnReader(next => switchSurface(next === 'terminal' ? 'terminal' : 'chat')), terminalTabAvailable: true, openDetailsTabCount: 0,
            switchSurface: next => { selections.push(next); switchSurface(next === 'terminal' ? 'terminal' : 'chat'); },
        }), [register, surface]);
        return null;
    }
    const scene = () => <runtime.Wrapper><MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
        <PaneRouteSelection params={route.params} /><TerminalSelection /><PresentedSessionChromeFixture /><MobileBottomChromeHost />
    </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider></runtime.Wrapper>;
    const screen = await renderScreen(scene());
    expect(pane === 'bottom' ? runtime.pane.scopeState?.bottom.isOpen : runtime.pane.scopeState?.right.isOpen).toBe(true);
    await act(async () => screen.findByType(SessionCockpitTabBar).props.onSurfacePress('chat'));
    await vi.waitFor(() => expect(selections).toEqual(['chat']));
    await screen.unmount();
});

it('keeps web-phone tabs and their Home on the focused workspace while Expo still names the previous route', async () => {
    viewport.width = 390;
    route.params = { serverId: 'expo-old-home' };
    storage.setState(state => ({ settings: { ...state.settings, mobileWorkspaceExperienceV1: 'cockpit' } }));
    const workspace: WorkspaceNavigationContextValue = {
        active: true,
        catalog: resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } }),
        state: createWorkspaceState({ id: 'workflows-tab', target: { kind: 'workflows', params: {} }, pinned: false, preview: false }),
        canGoBack: false, canGoForward: false, openHref: () => true,
        activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
        navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
        registerBackStep: () => () => {}, back: () => {}, forward: () => {},
    };
    const scene = (value: WorkspaceNavigationContextValue, sessionMounted = false) => <runtime.Wrapper><MainAppTabStateProvider>
        <SessionCockpitChromeRegistryProvider><WorkspaceNavigationProvider value={value}>
            <InboxSummaryProvider>{sessionMounted ? <CockpitSelection /> : null}<PresentedSessionChromeFixture /><MobileBottomChromeHost /></InboxSummaryProvider>
        </WorkspaceNavigationProvider></SessionCockpitChromeRegistryProvider>
    </MainAppTabStateProvider></runtime.Wrapper>;
    const screen = await renderScreen(scene(workspace));
    expect(screen.findAllByType(MainAppTabBar)).toHaveLength(1);
    expect(screen.findByType(MainAppTabBar).props.activeTab).toBe('workflows');
    await screen.update(scene({ ...workspace, state: createWorkspaceState({ id: 'session-tab',
        target: { kind: 'session', params: { id: 'resize-session', serverId: runtime.serverId } }, pinned: false, preview: false }) }, true));
    expect(screen.findByType(SessionCockpitTabBar).props.serverId).toBe(runtime.serverId);
    expect(route.params.serverId).toBe('expo-old-home');
    await screen.unmount();
});
