import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Text } from 'react-native';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';

const route = vi.hoisted(() => ({ pathname: '/', params: {} as Record<string, string>, navigate: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), setParams: vi.fn(), listeners: new Set<() => void>() }));
const native = vi.hoisted(() => ({
    os: 'web' as 'ios' | 'android' | 'web', width: 390, keyboardVisible: false,
    dimensionsListeners: new Set<() => void>(),
    animations: [] as Array<{ finish: () => void; toValue: number }>,
}));
vi.mock('expo-router', async () => {
    const router = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        pathname: () => route.pathname, params: () => route.params,
        router: { navigate: (href: unknown) => route.navigate(href), replace: (href: unknown) => route.replace(href), dismissTo: (href: unknown) => route.dismissTo(href),
            setParams: (params: unknown) => route.setParams(params) },
    });
    // The host is memoized; changing the external route must notify its mounted subscriber.
    return { ...router.module, usePathname: () => React.useSyncExternalStore(
        listener => { route.listeners.add(listener); return () => route.listeners.delete(listener); },
        () => route.pathname, () => route.pathname,
    ) };
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { get OS() { return native.os; }, select: (values: Record<string, unknown>) => values[native.os] ?? values.default },
    Dimensions: {
        get: () => ({ width: native.width, height: 844, scale: 1, fontScale: 1 }),
        addEventListener: (_event: string, listener: () => void) => {
            native.dimensionsListeners.add(listener);
            return { remove: () => native.dimensionsListeners.delete(listener) };
        },
    },
    Keyboard: { isVisible: () => native.keyboardVisible, addListener: () => ({ remove() {} }), dismiss() {} },
    Animated: {
        Value: class {
            constructor(private value: number) {}
            setValue(value: number) { this.value = value; }
            interpolate(config: unknown) { return { value: this.value, config }; }
            stopAnimation() {}
        },
        timing: (_value: unknown, config: { toValue: number }) => {
            let complete: ((result: { finished: boolean }) => void) | undefined;
            native.animations.push({ toValue: config.toValue, finish: () => complete?.({ finished: true }) });
            return { start: (callback?: typeof complete) => { complete = callback; }, stop() {} };
        },
        View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('AnimatedView', props, children),
    },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const runtime = installSessionPaneRuntimeTestHarness({ sessionId: 'session-1', request: async url => (
    new URL(String(url)).pathname === '/v1/kv/bulk' ? Response.json({ values: [] }) : null
) });
const { storage } = await import('@/sync/domains/state/storage');
const { InboxSummaryProvider } = await import('@/hooks/inbox/useInboxSummary');
const { MainAppTabStateProvider } = await import('./MainAppTabStateProvider');
const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
const { MobileBottomChromePortal } = await import('./MobileBottomChromePortal');
const { WorkspaceNavigationProvider } = await import('@/components/appShell/workspace/WorkspaceNavigationContext');
const { createWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
const { PresentedSessionChromeFixture } = await import('@/dev/testkit/harness/presentedDetailChrome');
const { MainAppTabBar } = await import('./bars/MainAppTabBar');
const { PagePinnedBar } = await import('@/components/ui/layout/PagePinnedBar');
const { SessionCockpitTabBar } = await import('./bars/SessionCockpitTabBar');
const { SessionCockpitChromeRegistryProvider, useSessionCockpitChromeRegister, useSessionCockpitBottomChromeHeight } = await import(
    '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry'
);
const { resolveSessionCockpitMobileCatalog } = await import('@/components/workspaceCockpit/session/sessionCockpitMobileCatalog');
const { normalizeSessionMobileSurface } = await import('@/components/workspaceCockpit/session/sessionCockpitState');
const { createSessionScmReviewDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
const { buildActiveDetailsRouteParams, parseSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');

// A mounted caller publishes a real catalog and column owner, exactly as the Session screen does.
// No registry, navigation Action, settings, feature decision or bar is replaced.
function MountedSession(props: Readonly<{ surface: SessionMobileSurface; terminalAvailable: boolean; detailsCount: number }>) {
    const register = useSessionCockpitChromeRegister();
    const [surface, setSurface] = React.useState(props.surface);
    React.useEffect(() => setSurface(props.surface), [props.surface]);
    const catalog = React.useMemo(() => resolveSessionCockpitMobileCatalog({ terminalTabAvailable: props.terminalAvailable }), [props.terminalAvailable]);
    React.useEffect(() => register({ sessionId: 'session-1', serverId: runtime.serverId, activeSurface: surface,
        terminalTabAvailable: props.terminalAvailable, openDetailsTabCount: props.detailsCount, catalog,
        readColumn: () => ({ present: true, visible: true, available: true, tabs: catalog.map(entry => entry.id),
            selectTab: id => { const next = normalizeSessionMobileSurface(id); if (next) setSurface(next); }, setVisible() {} }),
        switchSurface: setSurface,
    }), [catalog, props.detailsCount, props.terminalAvailable, register, surface]);
    return <Text testID="mounted-surface">{surface}</Text>;
}
function MeasurementReader() {
    return <Text testID="chrome-height">{useSessionCockpitBottomChromeHeight()}</Text>;
}
type HarnessProps = Readonly<{ mounted?: boolean; surface?: SessionMobileSurface; terminalAvailable?: boolean; detailsCount?: number; pageBar?: boolean; portal?: boolean; host?: boolean;
    /** The app's two mount sites for the portal (the workspace shell, the route layout), as `SidebarNavigator` and `(app)/_layout` render them. */
    sites?: readonly ('shell' | 'route')[]; workspaceActive?: boolean }>;
function Harness({ mounted = false, surface = 'chat', terminalAvailable = true, detailsCount = 0, pageBar = false, portal = false, host = true, sites, workspaceActive }: HarnessProps) {
    const body = <>
        {mounted ? <MountedSession surface={surface} terminalAvailable={terminalAvailable} detailsCount={detailsCount} /> : null}
        {pageBar ? <PagePinnedBar testID="page-bar"><Text>bar</Text></PagePinnedBar> : null}
        <PresentedSessionChromeFixture /><MeasurementReader />
        {sites ? sites.map(site => <SiteMarker key={site} site={site}><MobileBottomChromePortal site={site} /></SiteMarker>)
            : host ? portal ? <MobileBottomChromePortal site="route" /> : <MobileBottomChromeHost /> : null}
    </>;
    return <runtime.Wrapper><MainAppTabStateProvider><SessionCockpitChromeRegistryProvider><InboxSummaryProvider>
        {workspaceActive === undefined ? body : <WorkspaceNavigationProvider value={workspaceNavigation(workspaceActive)}>{body}</WorkspaceNavigationProvider>}
    </InboxSummaryProvider></SessionCockpitChromeRegistryProvider></MainAppTabStateProvider></runtime.Wrapper>;
}
function SiteMarker(props: React.PropsWithChildren<{ site: string }>) { return <>{props.children}</>; }
const noop = () => {};
function workspaceNavigation(active: boolean): import('@/components/appShell/workspace/WorkspaceNavigationContext').WorkspaceNavigationContextValue {
    return { active, state: createWorkspaceState({ id: 'tab', target: { kind: 'newTab', params: {} }, pinned: false, preview: true }),
        canGoBack: false, canGoForward: false, openHref: () => false, activateTab: noop, closeTab: noop, closeTabs: noop,
        dispatch: noop, navigationForTab: () => ({ push: noop, replace: noop, back: noop }), registerBackStep: () => noop,
        back: noop, forward: noop };
}
function enableCockpit() {
    storage.setState(state => ({ settings: { ...state.settings, mobileWorkspaceExperienceV1: 'cockpit' } }));
}
async function finishAnimations() {
    await act(async () => { for (const animation of native.animations.splice(0)) animation.finish(); });
}
async function navigateTo(pathname: string) {
    await act(async () => { route.pathname = pathname; for (const listener of route.listeners) listener(); });
}
/** The host writes the route from an effect after the cockpit's registration settles; let real time pass. */
async function waitForRouteWrite(spy: ReturnType<typeof vi.fn>) {
    for (let attempt = 0; attempt < 50 && spy.mock.calls.length === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(spy).toHaveBeenCalled();
}
function expectChatRoute() {
    expect(route.replace).toHaveBeenCalled();
    const href = new URL(String(route.replace.mock.lastCall?.[0]), 'https://chrome.test');
    expect(href.pathname).toBe('/session/session-1');
    expect(href.searchParams.get('serverId')).toBe(runtime.serverId);
    expect(href.searchParams.get('mobileSurface')).toBe('chat');
}
beforeEach(() => {
    route.pathname = '/'; route.params = { serverId: runtime.serverId };
    route.navigate.mockClear(); route.replace.mockClear(); route.dismissTo.mockClear(); route.setParams.mockClear();
    native.os = 'web'; native.width = 390; native.keyboardVisible = false; native.animations = [];
    storage.setState(state => ({ settings: { ...state.settings, mobileWorkspaceExperienceV1: 'classic' } }));
});

describe('MobileBottomChromeHost mounted chrome', () => {
    it('reserves the Session inset while launch data is pending and keeps it when the portal bar arrives', async () => {
        route.pathname = '/session/session-1'; enableCockpit();
        // The HTML shell owns this initial class; no Home or Session publisher has mounted yet.
        vi.stubGlobal('document', { body: null, documentElement: { classList: { contains: () => true, remove() {} } } });
        const { finishLaunchCurtain } = await import('@/boot/launchCurtain');
        try {
            // A launch on a chrome-less route never gains a band; Home reserves its eventual bar
            // without exposing portal content above the curtain. Exercise each as a fresh mount.
            for (const entry of [
                { pathname: '/new', width: 390, experience: 'cockpit', height: 56 },
                { pathname: '/settings/account', width: 390, experience: 'cockpit', height: 0 },
                { pathname: '/session/session-1', width: 390, experience: 'classic', height: 0 },
                { pathname: '/session/session-1', width: 1440, experience: 'cockpit', height: 0 },
                { pathname: '/', width: 390, experience: 'cockpit', height: 56 },
            ] as const) {
                route.pathname = entry.pathname; native.width = entry.width;
                storage.setState(state => ({ settings: { ...state.settings, mobileWorkspaceExperienceV1: entry.experience } }));
                const initial = await renderScreen(<Harness portal />);
                expect(initial.findAllByType(MainAppTabBar)).toHaveLength(0);
                expect(initial.findAllByType(SessionCockpitTabBar)).toHaveLength(0);
                expect(initial.findHostByTestId('chrome-height')?.props.children, JSON.stringify(entry)).toBe(entry.height);
                await initial.unmount();
            }
            route.pathname = '/session/session-1'; native.width = 390; enableCockpit();
            const screen = await renderScreen(<Harness portal />, {
                createNodeMock: element => element.props.testID === 'mobile-bottom-chrome-bar' ? { offsetHeight: 56 } : null,
            });
            expect(screen.findAllByType(SessionCockpitTabBar)).toHaveLength(0);
            expect(screen.findHostByTestId('chrome-height')?.props.children).toBe(56);
            await screen.update(<Harness portal mounted />);
            expect(screen.findAllByType(SessionCockpitTabBar)).toHaveLength(0);
            expect(screen.findHostByTestId('chrome-height')?.props.children).toBe(56);
            await act(async () => finishLaunchCurtain());
            expect(screen.findAllByType(SessionCockpitTabBar)).toHaveLength(1);
            expect(screen.findHostByTestId('chrome-height')?.props.children).toBe(56);
            await finishAnimations();
            expect(screen.findHostByTestId('chrome-height')?.props.children).toBe(56);
        } finally {
            finishLaunchCurtain();
            vi.unstubAllGlobals();
        }
    });
    it('mounts the one host with the web workspace shell, not behind the route layout that commits seconds later', async () => {
        // The production export loads routes as async chunks: the route layout (and a host mounted there) committed
        // seconds after the workspace painted the Session, so the composer drew without the bar's room and rose 56 px
        // when it arrived (K01, 3 of 3 cold loads at 390 on cut 53). The shell paints from the first frame.
        route.pathname = '/session/session-1'; enableCockpit();
        const hostSites = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAllByType(SiteMarker)
            .filter(marker => marker.findAllByType(MobileBottomChromeHost.type).length > 0).map(marker => marker.props.site);
        const web = await renderScreen(<Harness sites={['shell', 'route']} workspaceActive />);
        expect(hostSites(web)).toEqual(['shell']);
        await web.unmount();
        // The route layout has not committed yet: the shell alone reserves the Session's room.
        const shellOnly = await renderScreen(<Harness sites={['shell']} workspaceActive />);
        expect(shellOnly.findHostByTestId('chrome-height')?.props.children).toBe(56);
        await shellOnly.unmount();
        // Without a workspace, and natively, the route layout keeps it.
        const noWorkspace = await renderScreen(<Harness sites={['shell', 'route']} workspaceActive={false} />);
        expect(hostSites(noWorkspace)).toEqual(['route']);
        await noWorkspace.unmount();
        native.os = 'ios';
        const nativeShell = await renderScreen(<Harness sites={['shell', 'route']} workspaceActive />);
        expect(hostSites(nativeShell)).toEqual(['route']);
    });
    it('presents Voice before the lazy route commits and retains it when the route arrives', async () => {
        route.pathname = '/session/session-1'; enableCockpit();
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
        const { resetVoiceSessionStoreForTests, setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready',
            features: createRootLayoutFeaturesResponse({ features: { voice: { enabled: true } } }) } });
        storage.setState(state => ({ settings: { ...state.settings, experiments: true,
            featureToggles: { ...state.settings.featureToggles, voice: true, 'voice.agent': true, 'execution.runs': true },
            voice: voiceSettingsParse({ providerId: 'local_conversation', providers: {
                local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
            } }),
        }, localSettings: { ...state.localSettings, voicePresenceContainer: 'island' } }));
        registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
        setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'cold-shell', status: 'connected', mode: 'listening', canStop: true });
        try {
            const screen = await renderScreen(<Harness sites={['shell']} workspaceActive />);
            expect(screen.findAllHostsByTestId('voice-presence-app-shell-root')).toHaveLength(1);
            await screen.update(<Harness sites={['shell', 'route']} workspaceActive />);
            expect(screen.findAllHostsByTestId('voice-presence-app-shell-root')).toHaveLength(1);
        } finally {
            resetVoiceSessionStoreForTests();
            registerVoiceAdapters([]);
        }
    });
    // FIN N4: one bottom chrome at a time; the page's own bar wins and the shell's bar comes back after it.
    it('gives the bottom to a page\'s own pinned bar and takes it back when the bar leaves', async () => {
        const screen = await renderScreen(<Harness pageBar />);
        await finishAnimations();
        expect(screen.findAllByType(MainAppTabBar)).toHaveLength(0);
        await screen.update(<Harness />);
        await finishAnimations();
        expect(screen.findAllByType(MainAppTabBar)).toHaveLength(1);
    });
    // Holding the bar docks the Session switcher on a native phone, so a tab's menu never competes with it.
    it.each([['android', false], ['web', true]] as const)('on %s a held Session tab opens its menu: %s', async (os, offersMenu) => {
        native.os = os; route.pathname = '/session/session-1/files'; enableCockpit();
        const screen = await renderScreen(<Harness mounted surface="browse" />);
        await finishAnimations();
        expect(typeof screen.findHostByTestId('session-cockpit-tab-browse')?.props.onLongPress === 'function').toBe(offersMenu);
    });
    it('renders the authenticated Home tab and ignores selecting it again', async () => {
        const screen = await renderScreen(<Harness />);
        expect(screen.findByType(MainAppTabBar).props.activeTab).toBe('sessions');
        await screen.pressByTestIdAsync('tabbar-tab-sessions');
        expect(screen.findByType(MainAppTabBar).props.activeTab).toBe('sessions');
        expect(route.navigate).not.toHaveBeenCalled();
        expect(route.replace).not.toHaveBeenCalled();
    });
    it('reserves a cold mounted Session before the web bar has any measurable node', async () => {
        route.pathname = '/session/session-1'; enableCockpit();
        // Registration can precede the shell's first commit: there is no detailPending frame,
        // and RNW has not delivered onLayout or exposed a measurable DOM node yet.
        const screen = await renderScreen(<Harness mounted host={false} />);
        await screen.update(<Harness mounted />);
        expect(screen.findAllByType(SessionCockpitTabBar)).toHaveLength(1);
        expect(screen.findHostByTestId('chrome-height')?.props.children).toBe(56);
        await finishAnimations();
        expect(screen.findHostByTestId('chrome-height')?.props.children).toBe(56);
    });
    it('publishes the measured chrome height through the real registry', async () => {
        const screen = await renderScreen(<Harness />);
        const measurement = screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')
            .find(node => node.findAll(child => child.props.testID === 'tabbar-tab-sessions').length > 0);
        expect(measurement).toBeDefined();
        await act(async () => measurement?.props.onLayout({ nativeEvent: { layout: { height: 42.2 } } }));
        expect(screen.findHostByTestId('chrome-height')?.props.children).toBe(42);
    });
    it('publishes the bar height in the commit that first draws the bar, before any layout event', async () => {
        // A web layout event is delivered a task after paint, so a composer that reserved only from it painted
        // once without the bar's room and then moved up by the bar's height (K01 cold load, 56 px at 390).
        const screen = await renderScreen(<Harness />, {
            createNodeMock: element => element.props.testID === 'mobile-bottom-chrome-bar' ? { offsetHeight: 56.4 } : null,
        });
        expect(screen.findHostByTestId('chrome-height')?.props.children).toBe(56);
    });
    it('reserves the Session bar\'s room from first paint while the Session has not drawn its bar yet', async () => {
        // A slow Home delays the Session's own bar by seconds, and the composer then rose by the bar's height
        // (delta check 21: 4 of 4 cold loads at 390). The bar's height is known before it draws.
        route.pathname = '/session/session-1'; enableCockpit();
        const screen = await renderScreen(<Harness />, {
            createNodeMock: element => element.props.testID === 'mobile-bottom-chrome-bar' ? { offsetHeight: 56 } : null,
        });
        expect(screen.findAllByType(SessionCockpitTabBar)).toHaveLength(0);
        expect(screen.findHostByTestId('chrome-height')?.props.children).toBe(56);
        await screen.update(<Harness mounted />);
        expect(screen.findAllByType(SessionCockpitTabBar)).toHaveLength(1);
        expect(screen.findHostByTestId('chrome-height')?.props.children).toBe(56);
    });
    it.each([
        ['Classic', '/session/session-1', 390, false],
        ['a wide window', '/session/session-1', 1440, true],
        ['a pushed Settings page', '/settings/session', 390, true],
    ] as const)('reserves no bar room on %s, where no phone bar will stand', async (_case, pathname, width, cockpit) => {
        route.pathname = pathname; native.width = width; if (cockpit) enableCockpit();
        const screen = await renderScreen(<Harness />);
        expect(screen.findHostByTestId('chrome-height')?.props.children).toBe(0);
    });
    it('offers new Session creation only beside Sessions and selects Workflows from its route', async () => {
        const screen = await renderScreen(<Harness />);
        expect(screen.findByType(MainAppTabBar).props.trailingAccessory).toBeTruthy();
        await navigateTo('/workflows');
        await screen.update(<Harness />);
        expect(screen.findByType(MainAppTabBar).props.activeTab).toBe('workflows');
        // Off Sessions the "+" is the page's own create action, and a page that lends none leaves the cell empty.
        expect(screen.findHostByTestId('tabbar-start-new-session')).toBeNull();
        expect(screen.root.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('tabbar-create:'))).toHaveLength(0);
    });
    it('keeps the bar on a More destination without claiming Sessions is here (QA-PHONE P1)', async () => {
        const screen = await renderScreen(<Harness />);
        await navigateTo('/machines');
        await screen.update(<Harness />);
        await finishAnimations();
        expect(screen.findByType(MainAppTabBar)).toBeTruthy();
        expect(screen.findHostByTestId('tabbar-tab-sessions')).not.toBeNull();
        expect(screen.findHostByTestId('tabbar-tab-sessions')?.props.current).toBeUndefined();
        expect(screen.findHostByTestId('tabbar-start-new-session')).toBeNull();
    });
    it('offers More from the bar itself on Sessions and on a tab with its own route', async () => {
        const screen = await renderScreen(<Harness />);
        expect(screen.findByTestId('phone-launcher-button')).toBeTruthy();
        await navigateTo('/workflows');
        await screen.update(<Harness />);
        expect(screen.findByType(MainAppTabBar).props.activeTab).toBe('workflows');
        expect(screen.findByTestId('phone-launcher-button')).toBeTruthy();
    });
    it.each(['ios', 'android', 'web'] as const)('paints Home when directly linked to the composer on %s', async os => {
        native.os = os; route.pathname = '/new';
        const screen = await renderScreen(<Harness />);
        expect(screen.findByType(MainAppTabBar).props.activeTab).toBe('sessions');
    });
    it.each(['ios', 'android', 'web'] as const)('retains Home under the composer and after dismissal on %s', async os => {
        native.os = os;
        const screen = await renderScreen(<Harness />);
        const before = screen.findByType(MainAppTabBar);
        await navigateTo('/new');
        expect(screen.findByType(MainAppTabBar)).toBe(before);
        await navigateTo('/');
        expect(screen.findByType(MainAppTabBar)).toBe(before);
    });
    // Owner 2026-11-17: main tabs are peer views. Sessions, Inbox and Projects share the root screen, so pressing one
    // from a pushed section returns to that retained screen instead of stacking a second root and a history entry.
    it('navigates from route-owned Workflows to Home and back through the real controls', async () => {
        route.pathname = '/workflows';
        const screen = await renderScreen(<Harness />);
        await screen.pressByTestIdAsync('tabbar-tab-sessions');
        expect({ dismissTo: route.dismissTo.mock.calls, navigate: route.navigate.mock.calls }).toEqual({ dismissTo: [['/']], navigate: [] });
        await navigateTo('/');
        route.navigate.mockClear();
        await screen.pressByTestIdAsync('tabbar-tab-workflows');
        expect(route.navigate).toHaveBeenCalledWith('/workflows');
        expect(route.replace).not.toHaveBeenCalled();
    });
    // Owner 11-06: Session history is a Sessions page and Home is a More page; both keep the main bar.
    it.each(['/session/archived', '/session/recent', '/home'])('keeps the main bar on %s', async pathname => {
        route.pathname = pathname; enableCockpit();
        const screen = await renderScreen(<Harness />);
        expect(screen.findAllByType(MainAppTabBar)).toHaveLength(1);
        expect(screen.findAllByType(SessionCockpitTabBar)).toHaveLength(0);
    });
    // Owner 11-10: Settings is a main screen like the others; the bar stands on its own page, its pushed pages keep their Back.
    it.each([false, true])('keeps the main bar on the Settings main screen (cockpit: %s)', async cockpit => {
        route.pathname = '/settings'; if (cockpit) enableCockpit();
        const screen = await renderScreen(<Harness />);
        expect(screen.findAllByType(MainAppTabBar)).toHaveLength(1);
        expect(screen.findAllByType(SessionCockpitTabBar)).toHaveLength(0);
    });
    // A hidden destination is a flow catalogued only for its route (Personalize, a bot template, a Team's setup): no section
    // or More entry claims it, so its steps own the bottom and no bar stands over them.
    it.each(['/personalize', '/bot-template', '/teams/team-1/setup'])('draws no main bar over the %s flow', async pathname => {
        route.pathname = pathname;
        const screen = await renderScreen(<Harness />);
        expect(screen.findAllByType(MainAppTabBar)).toHaveLength(0);
    });
    it.each(['/settings/session', '/session/session-1', '/session/session-1/details'])('does not invent a bar from %s without a mounted owner', async pathname => {
        route.pathname = pathname; enableCockpit();
        if (pathname.endsWith('/details')) route.params.sourceSurface = 'browse';
        const screen = await renderScreen(<Harness />);
        expect(screen.findAllByType(MainAppTabBar)).toHaveLength(0);
        expect(screen.findAllByType(SessionCockpitTabBar)).toHaveLength(0);
        expect(route.replace).not.toHaveBeenCalled();
    });
    it('does not render Home chrome in a wide window', async () => {
        native.width = 1440;
        const screen = await renderScreen(<Harness />);
        expect(screen.findAllByType(MainAppTabBar)).toHaveLength(0);
    });
    it.each(['/session/session-1/files', '/session/session-1/file/src%2Findex.ts'])('uses the mounted catalog even on %s', async pathname => {
        route.pathname = pathname; enableCockpit();
        const screen = await renderScreen(<Harness mounted surface="browse" detailsCount={2} />);
        const bar = screen.findByType(SessionCockpitTabBar);
        expect(bar.props.activeSurface).toBe('browse');
        expect(bar.props.sessionId).toBe('session-1');
        expect(bar.props.openDetailsTabCount).toBe(2);
        expect(screen.findHostByTestId('session-cockpit-tab-browse')).not.toBeNull();
    });
    it('shows the mounted Session when cockpit mode is enabled while already viewing it', async () => {
        route.pathname = '/session/session-1';
        const screen = await renderScreen(<Harness mounted />);
        expect(screen.findAllByType(SessionCockpitTabBar)).toHaveLength(0);
        await act(async () => enableCockpit());
        expect(screen.findByType(SessionCockpitTabBar).props.activeSurface).toBe('chat');
    });
    it.each(['ios', 'android'] as const)('lets immersive SCM Details own its bottom controls on %s', async os => {
        native.os = os; route.pathname = '/session/session-1/details'; enableCockpit();
        const tab = createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree', comparisonId: 'pending' }, view: 'walkthrough' });
        route.params = { ...route.params, ...buildActiveDetailsRouteParams([tab], tab.key) };
        const screen = await renderScreen(<Harness mounted surface="tabs" detailsCount={1} />);
        expect(screen.findAllByType(SessionCockpitTabBar)).toHaveLength(0);
    });
    it.each([false, true])('uses the mounted terminal availability (%s)', async terminalAvailable => {
        route.pathname = '/session/session-1'; enableCockpit();
        const screen = await renderScreen(<Harness mounted terminalAvailable={terminalAvailable} />);
        expect(screen.findByType(SessionCockpitTabBar).props.terminalTabAvailable).toBe(terminalAvailable);
        expect(screen.findByType(SessionCockpitTabBar).props.catalog.some((entry: { id: string }) => entry.id === 'terminal')).toBe(terminalAvailable);
    });
    it.each([false, true])('retains the main or Session bar while the native keyboard is visible (Session: %s)', async mounted => {
        if (mounted) { route.pathname = '/session/session-1'; enableCockpit(); }
        native.keyboardVisible = true;
        const screen = await renderScreen(<Harness mounted={mounted} />);
        expect(screen.findAllByType(mounted ? SessionCockpitTabBar : MainAppTabBar)).toHaveLength(1);
    });
    it.each(['/session/session-1/files', '/session/session-1/terminal'])('selects the mounted column and preserves Home scope from %s', async pathname => {
        route.pathname = pathname; enableCockpit();
        const screen = await renderScreen(<Harness mounted surface={pathname.endsWith('terminal') ? 'terminal' : 'browse'} />);
        await screen.pressByTestIdAsync('session-cockpit-tab-chat');
        await vi.waitFor(() => expect(screen.findHostByTestId('mounted-surface')?.props.children).toBe('chat'));
        expectChatRoute();
    });
    // Owner 2026-11-17: cockpit tabs are peer views of the one Session route. A press keeps the route and adds no
    // history (Back leaves the Session); on a native stack only the route's query moves, so the retained cockpit and
    // its scenes are reused instead of rebuilt under a new child route.
    it.each(['browse', 'git', 'terminal'] as const)('a %s tab press on the web replaces the Session route with its surface query', async surface => {
        route.pathname = '/session/session-1'; route.params.mobileSurface = 'chat'; enableCockpit();
        const screen = await renderScreen(<Harness mounted />);
        // The host mirrors only presses after the cockpit's own registration (a restored deep link is never rewritten).
        await vi.waitFor(() => expect(screen.findByType(SessionCockpitTabBar).props.activeSurface).toBe('chat'));
        // The web bar also draws preview copies of its cells; press the bar the host owns.
        await act(async () => screen.findByType(SessionCockpitTabBar).props.onSurfacePress(surface));
        await waitForRouteWrite(route.replace);
        const href = new URL(String(route.replace.mock.lastCall?.[0]), 'https://chrome.test');
        expect({ path: href.pathname, surface: href.searchParams.get('mobileSurface'), serverId: href.searchParams.get('serverId'),
            pushes: route.navigate.mock.calls.length })
            .toEqual({ path: '/session/session-1', surface, serverId: runtime.serverId, pushes: 0 });
    });
    it.each(['browse', 'git', 'terminal'] as const)('a %s tab press on a native phone moves only the Session route query', async surface => {
        native.os = 'android'; route.pathname = '/session/session-1'; route.params.mobileSurface = 'chat'; enableCockpit();
        const screen = await renderScreen(<Harness mounted />);
        // The host mirrors only presses after the cockpit's own registration (a restored deep link is never rewritten).
        await vi.waitFor(() => expect(screen.findByType(SessionCockpitTabBar).props.activeSurface).toBe('chat'));
        await screen.pressByTestIdAsync(`session-cockpit-tab-${surface}`);
        await waitForRouteWrite(route.setParams);
        expect({ params: route.setParams.mock.lastCall?.[0], replaces: route.replace.mock.calls.length, pushes: route.navigate.mock.calls.length })
            .toEqual({ params: { mobileSurface: surface }, replaces: 0, pushes: 0 });
    });
    it('retains the selected cockpit tab after incidental native vertical movement', async () => {
        native.os = 'android'; route.pathname = '/session/session-1'; enableCockpit();
        const screen = await renderScreen(<Harness mounted />);
        await screen.pressByTestIdAsync('session-cockpit-tab-browse');
        await vi.waitFor(() => expect(screen.findHostByTestId('mounted-surface')?.props.children).toBe('browse'));
        // Inspect only the native gesture-handler boundary supplied by the canonical stub.
        type NativePan = { __config: { testId?: string; enabled?: boolean }; __handlers: {
            onBegin: () => void; onStart: (event: { translationX: number; translationY: number; absoluteY: number }) => void;
            onEnd: (event: { translationX: number; translationY: number; velocityX: number; velocityY: number }, success: boolean) => void;
        } };
        const pan = screen.tree.findAllByType('GestureDetector' as never)
            .flatMap(node => (node.props.gesture as { gestures: NativePan[] }).gestures)
            .find(gesture => gesture.__config.testId === 'session-cockpit-lateral-swipe');
        expect(pan).toBeDefined();
        expect(pan?.__config.enabled).toBe(true);
        await act(async () => {
            pan!.__handlers.onBegin();
            pan!.__handlers.onStart({ translationX: 0, translationY: 16, absoluteY: 800 });
            pan!.__handlers.onEnd({ translationX: 0, translationY: 16, velocityX: 0, velocityY: 0 }, true);
        });
        expect(storage.getState().settings.mobileWorkspaceExperienceV1).toBe('cockpit');
        expect(screen.findByType(SessionCockpitTabBar).props.activeSurface).toBe('browse');
        expect(screen.findHostByTestId('mounted-surface')?.props.children).toBe('browse');
    });
    it('mirrors a Back-selected registered surface without rewriting the initial deep link', async () => {
        route.pathname = '/session/session-1/git'; enableCockpit();
        const screen = await renderScreen(<Harness mounted surface="git" />);
        expect(route.replace).not.toHaveBeenCalled();
        await screen.update(<Harness mounted surface="chat" />);
        expect(screen.findByType(SessionCockpitTabBar).props.activeSurface).toBe('chat');
        expectChatRoute();
    });
    it('keeps the registered root surface selected when remounted with its route hint', async () => {
        route.pathname = '/session/session-1'; route.params.mobileSurface = 'chat'; enableCockpit();
        const screen = await renderScreen(<Harness mounted surface="chat" />);
        expect(screen.findByType(SessionCockpitTabBar).props.activeSurface).toBe('chat');
        expect(route.replace).not.toHaveBeenCalled();
    });
    it.each(['navigator', 'press'] as const)('preserves an exact comparison when %s presents phone Details', async trigger => {
        route.pathname = '/session/session-1'; enableCockpit();
        const tab = createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree', comparisonId: 'pending-comparison' },
            view: 'walkthrough', explain: true, evidenceSessionId: 'evidence-session' });
        route.params = { ...route.params, ...buildActiveDetailsRouteParams([tab], tab.key) };
        const expected = parseSessionPaneUrlState(route.params);
        const screen = await renderScreen(<Harness mounted detailsCount={1} />);
        if (trigger === 'navigator') await screen.update(<Harness mounted surface="tabs" detailsCount={1} />);
        else await act(async () => screen.findByType(SessionCockpitTabBar).props.onSurfacePress('tabs'));
        await vi.waitFor(() => expect(screen.findHostByTestId('mounted-surface')?.props.children).toBe('tabs'));
        expect(route.replace).not.toHaveBeenCalled();
        expect(parseSessionPaneUrlState(route.params)).toEqual(expected);
    });
    it('keeps outgoing chrome inaccessible while cross-fading to an already registered Session and retires it on completion', async () => {
        enableCockpit();
        const screen = await renderScreen(<Harness mounted surface="browse" />);
        await navigateTo('/session/session-1/files');
        expect(screen.findAllByType(MainAppTabBar)).toHaveLength(1);
        expect(screen.findAllByType(SessionCockpitTabBar)).toHaveLength(1);
        const outgoing = screen.tree.findAllByType('AnimatedView' as never)
            .find(node => node.findAll(child => child.props.testID === 'tabbar-tab-sessions').length > 0);
        expect(outgoing?.props.pointerEvents).toBe('none');
        expect(outgoing?.props.accessibilityElementsHidden).toBe(true);
        expect(outgoing?.props.importantForAccessibility).toBe('no-hide-descendants');
        await finishAnimations();
        expect(screen.findAllByType(MainAppTabBar)).toHaveLength(0);
        expect(screen.findAllByType(SessionCockpitTabBar)).toHaveLength(1);
    });
    it('shows the destination main bar immediately when returning from the Session', async () => {
        route.pathname = '/session/session-1/files'; enableCockpit();
        const screen = await renderScreen(<Harness mounted surface="browse" />);
        await navigateTo('/');
        await screen.update(<Harness />);
        expect(screen.findByType(MainAppTabBar).props.activeTab).toBe('sessions');
        expect(screen.findAllByType(SessionCockpitTabBar)).toHaveLength(1);
        await finishAnimations();
        expect(screen.findAllByType(SessionCockpitTabBar)).toHaveLength(0);
    });
});
