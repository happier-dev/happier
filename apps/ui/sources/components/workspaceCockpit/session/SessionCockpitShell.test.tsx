import * as React from 'react';

import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionCockpitSurfaceNavigationProvider } from './SessionCockpitSurfaceNavigation';
import {
    SessionCockpitChromeRegistryProvider,
    useSessionCockpitChromeRegistration,
} from './SessionCockpitChromeRegistry';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let localSettingsMock: Record<string, unknown> = {};
const safeAreaInsetsMock = vi.hoisted(() => ({
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
}));
const pluginProjectionState = vi.hoisted<{
    value: {
        pluginUiProjection: unknown;
        machineId: string | null;
        serverId: string | null;
        platform: 'web';
    };
}>(() => ({
    value: {
        pluginUiProjection: null,
        machineId: 'machine-1',
        serverId: 'server-1',
        platform: 'web',
    },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: (key: string) => localSettingsMock[key],
        useLocalSettingMutable: (key: string) => [
            localSettingsMock[key],
            (value: unknown) => {
                localSettingsMock[key] = value;
            },
        ],
    });
});

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => true,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => safeAreaInsetsMock,
}));

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: (props: Record<string, unknown> & { contentOverride?: React.ReactNode }) => React.createElement(
        'SessionView',
        props,
        props.contentOverride ?? null,
    ),
}));

vi.mock('@/components/sessions/panes/SessionDetailsPanel', () => ({
    SessionDetailsPanel: (props: Record<string, unknown>) => React.createElement('SessionDetailsPanel', props),
}));

vi.mock('@/components/sessions/panes/surfaces/SessionBrowseFilesSurface', () => ({
    SessionBrowseFilesSurface: (props: Record<string, unknown>) => React.createElement('SessionBrowseFilesSurface', props),
}));

vi.mock('@/components/sessions/panes/surfaces/SessionGitSurface', () => ({
    SessionGitSurface: (props: Record<string, unknown>) => React.createElement('SessionGitSurface', props),
}));

vi.mock('@/components/sessions/panes/surfaces/SessionTerminalSurface', () => ({
    SessionTerminalSurface: (props: Record<string, unknown>) => React.createElement('SessionTerminalSurface', props),
}));

vi.mock('@/components/browser/surfaces', () => ({
    BrowserSurfaceHost: (props: Record<string, unknown>) => React.createElement('BrowserSurfaceHost', props),
    createOpenBrowserTargetInWorkspace: () => vi.fn(),
    mapLocalServiceLaunchTargetToBrowserTarget: (target: unknown) => target,
    resolveBrowserSurfacePlatform: () => 'desktop',
}));

vi.mock('@/components/browser/surfaces/BrowserSurfaceHost', () => ({
    BrowserSurfaceHost: (props: Record<string, unknown>) => React.createElement('BrowserSurfaceHost', props),
}));

vi.mock('@/components/browser/surfaces/BrowserMobileSurfaceScreen', () => ({
    BrowserMobileSurfaceScreen: (props: Record<string, unknown>) => React.createElement('BrowserMobileSurfaceScreen', props),
}));

vi.mock('@/components/sessions/localServices', () => ({
    DetectedLocalServicesPane: (props: Record<string, unknown>) => React.createElement('DetectedLocalServicesPane', props),
    LocalServicesSurfaceHost: (props: Record<string, unknown>) => React.createElement('DetectedLocalServicesPane', props),
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => pluginProjectionState.value,
}));

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: () => pluginProjectionState.value,
}));

vi.mock('@/components/plugins/surfaces', () => ({
    PluginSurfacePlacementHost: (props: Record<string, unknown>) => React.createElement('PluginSurfacePlacementHostStub', props),
    PluginSurfacePlacementStack: (props: Record<string, unknown>) => React.createElement('PluginSurfacePlacementStackStub', props),
}));

function createPluginProjection() {
    const placement = {
        id: 'pluginUi:review:surfacePlacement:review-panel',
        pluginId: 'review',
        contributionKind: 'surfacePlacement',
        descriptorId: 'review-panel',
        placement: 'session.rightSidebarTab',
        target: { kind: 'session' },
        renderer: { kind: 'host', rendererId: 'review.panel' },
        display: { developerFallback: 'Review' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        order: 70,
        rightSidebar: {
            tabId: 'review',
            scope: 'session',
            order: 70,
            mobile: { enabled: true, surface: 'pluginTab' },
            disabledPolicy: 'disable',
        },
    };
    return Object.freeze({
        generation: 4,
        translationsByPluginId: Object.freeze({}),
        structuredMessagesByKind: Object.freeze({}),
        sessionHeaderActionsById: Object.freeze({}),
        hostedWebById: Object.freeze({}),
        reactNativeBundlesById: Object.freeze({}),
        surfacePlacementsById: Object.freeze({ [placement.id]: placement }),
        surfacePlacementsByPlacement: Object.freeze({ 'session.rightSidebarTab': Object.freeze([placement]) }),
        uiArtifactsById: Object.freeze({}),
        digestsByPluginId: Object.freeze({}),
        unknownEntriesById: Object.freeze({}),
    });
}

function PaneScopeProbe(props: Readonly<{ scopeId: string }>) {
    const pane = useAppPaneScope(props.scopeId);

    return React.createElement('PaneScopeProbe', {
        scopeState: pane.scopeState,
    });
}

function CockpitRegistrationProbe() {
    const registration = useSessionCockpitChromeRegistration();

    return React.createElement('CockpitRegistrationProbe', { registration });
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('SessionCockpitSurfaceScreen', () => {
    beforeEach(() => {
        standardCleanup();
        localSettingsMock = {};
        safeAreaInsetsMock.top = 0;
        safeAreaInsetsMock.bottom = 0;
        safeAreaInsetsMock.left = 0;
        safeAreaInsetsMock.right = 0;
        pluginProjectionState.value = {
            pluginUiProjection: null,
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
        };
    });

    it('closes an already-open right pane when the chat surface becomes active', async () => {
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: true, activeTabId: 'terminal', tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceScreen
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="chat"
                    routeServerId="server-b"
                    terminalTabAvailable
                />
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        await act(async () => {
            await screen.update(
                <AppPaneProvider>
                    <SessionCockpitSurfaceScreen
                        sessionId="s_1"
                        scopeId="session:s_1"
                        surface="chat"
                        routeServerId="server-b"
                        terminalTabAvailable
                    />
                    <PaneScopeProbe scopeId="session:s_1" />
                </AppPaneProvider>,
            );
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(probe.props.scopeState?.right).toEqual(expect.objectContaining({
            isOpen: false,
            activeTabId: 'terminal',
        }));
        const sessionView = screen.tree.findByType('SessionView' as never);
        expect(sessionView.props.id).toBe('s_1');
        expect(sessionView.props.routeServerId).toBe('server-b');
        expect(sessionView.props.routeAnchorOverride).toBe(true);
        expect(sessionView.props.chatBottomSpacing).toBe('none');
    });

    it('publishes the focused surface as the cockpit navigation owner', async () => {
        const switchSurface = vi.fn();
        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitChromeRegistryProvider>
                    <SessionCockpitSurfaceNavigationProvider value={{ switchSurface }}>
                        <SessionCockpitSurfaceScreen
                            sessionId="s_1"
                            scopeId="session:s_1"
                            surface="chat"
                            routeServerId="server-b"
                            terminalTabAvailable
                        />
                    </SessionCockpitSurfaceNavigationProvider>
                    <CockpitRegistrationProbe />
                </SessionCockpitChromeRegistryProvider>
            </AppPaneProvider>,
        );

        const registration = screen.tree.findByType('CockpitRegistrationProbe' as never).props.registration;
        expect(registration).toEqual(expect.objectContaining({
            sessionId: 's_1',
            activeSurface: 'chat',
            terminalTabAvailable: true,
        }));

        await act(async () => {
            registration.switchSurface('terminal');
        });
        expect(switchSurface).toHaveBeenCalledWith('terminal');
    });

    it('closes the details presentation when returning to chat from an opened details surface', async () => {
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: true,
                        tabs: [
                            {
                                key: 'scmReview:working',
                                kind: 'scmReview',
                                title: 'Review',
                                isPinned: true,
                                isPreview: false,
                                resource: { kind: 'scmReview' },
                            },
                        ],
                        activeTabKey: 'scmReview:working',
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceScreen
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="chat"
                    terminalTabAvailable
                />
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        await act(async () => {
            await screen.update(
                <AppPaneProvider>
                    <SessionCockpitSurfaceScreen
                        sessionId="s_1"
                        scopeId="session:s_1"
                        surface="chat"
                        terminalTabAvailable
                    />
                    <PaneScopeProbe scopeId="session:s_1" />
                </AppPaneProvider>,
            );
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(probe.props.scopeState?.details).toEqual(expect.objectContaining({
            isOpen: false,
            activeTabKey: 'scmReview:working',
        }));
        expect(probe.props.scopeState?.details?.tabs).toHaveLength(1);
    });

    it('renders a stable terminal screen wrapper when the terminal surface is active', async () => {
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceScreen
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="terminal"
                    routeServerId="server-b"
                    terminalTabAvailable
                />
            </AppPaneProvider>,
        );

        const sessionView = screen.tree.findByType('SessionView' as never);
        expect(sessionView.props.id).toBe('s_1');
        expect(sessionView.props.routeServerId).toBe('server-b');
        expect(sessionView.props.contentOverride).toBeTruthy();
        expect(screen.tree.findByProps({ testID: 'session-terminal-screen' } as never)).toBeTruthy();
        expect(screen.tree.findByType('SessionTerminalSurface' as never).props.sessionId).toBe('s_1');
    });

    it('delegates route-owned safe-area padding to the shared session chrome', async () => {
        safeAreaInsetsMock.top = 24;
        safeAreaInsetsMock.bottom = 12;
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceScreen
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="terminal"
                    safeAreaPadding={false}
                    terminalTabAvailable
                />
            </AppPaneProvider>,
        );

        const sessionView = screen.tree.findByType('SessionView' as never);
        expect(sessionView.props.safeAreaTopMode).toBe('internal');
        expect(sessionView.props.headerSafeAreaTopMode).toBe('internal');

        const terminalScreen = screen.tree.findByProps({ testID: 'session-terminal-screen' } as never);
        expect(flattenStyle(terminalScreen.props.style)).toMatchObject({
            paddingTop: 0,
            paddingBottom: 0,
        });
    });

    it('uses screen presentation for fallback details when the route owns safe-area padding', async () => {
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceScreen
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="tabs"
                    safeAreaPadding={false}
                    terminalTabAvailable
                />
            </AppPaneProvider>,
        );

        const detailsPanel = screen.tree.findByType('SessionDetailsPanel' as never);
        expect(detailsPanel.props.presentation).toBe('screen');
        expect(detailsPanel.props.showHeaderActions).toBe(false);
    });

    it('renders the mobile Browser cockpit surface through BrowserSurfaceHost', async () => {
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceScreen
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="browser"
                    routeServerId="server-b"
                    terminalTabAvailable
                />
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        expect(screen.tree.findByProps({ testID: 'session-browser-screen' } as never)).toBeTruthy();
        // The mobile Browser surface mounts the scoped details-workspace browser engine (D2-revised),
        // not a bespoke BrowserSurfaceHost bar; the cockpit threads a dedicated browser pane scope.
        const browserScreen = screen.tree.findByType('BrowserMobileSurfaceScreen' as never);
        expect(browserScreen.props.sessionId).toBe('s_1');
        expect(browserScreen.props.scopeId).toBe('session:s_1:browser');
        expect(screen.tree.findByType('SessionView' as never).props.routeServerId).toBe('server-b');
        expect(screen.tree.findByType('PaneScopeProbe' as never).props.scopeState?.right?.isOpen).toBe(false);
    });

    it('renders the mobile Services cockpit surface through DetectedLocalServicesPane', async () => {
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceScreen
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="services"
                    routeServerId="server-b"
                    terminalTabAvailable
                />
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        expect(screen.tree.findByProps({ testID: 'session-services-screen' } as never)).toBeTruthy();
        const servicesHost = screen.tree.findByType('DetectedLocalServicesPane' as never);
        expect(servicesHost.props.testID).toBe('session-mobile-services');
        expect(servicesHost.props.sessionId).toBe('s_1');
        expect(screen.tree.findByType('SessionView' as never).props.routeServerId).toBe('server-b');
        expect(screen.tree.findByType('PaneScopeProbe' as never).props.scopeState?.right?.isOpen).toBe(false);
    });

    it('opens file details on the internal details tab without pushing a sibling stack route', async () => {
        const switchSurface = vi.fn();
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceNavigationProvider value={{ switchSurface }}>
                    <SessionCockpitSurfaceScreen
                        sessionId="s_1"
                        scopeId="session:s_1"
                        surface="browse"
                        routeServerId="server-b"
                        terminalTabAvailable
                    />
                </SessionCockpitSurfaceNavigationProvider>
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        const browseSurface = screen.tree.findByType('SessionBrowseFilesSurface' as never);

        await act(async () => {
            browseSurface.props.onOpenFile('src/example.ts');
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(switchSurface).toHaveBeenCalledWith('tabs');
        expect(probe.props.scopeState?.details?.isOpen).toBe(true);
        expect(probe.props.scopeState?.details?.tabs).toEqual([
            expect.objectContaining({
                key: 'file:src/example.ts',
                resource: { kind: 'file', path: 'src/example.ts' },
            }),
        ]);
    });

    it('opens commit details on the internal details tab without pushing a sibling stack route', async () => {
        const switchSurface = vi.fn();
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceNavigationProvider value={{ switchSurface }}>
                    <SessionCockpitSurfaceScreen
                        sessionId="s_1"
                        scopeId="session:s_1"
                        surface="git"
                        routeServerId="server-b"
                        terminalTabAvailable
                    />
                </SessionCockpitSurfaceNavigationProvider>
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        const gitSurface = screen.tree.findByType('SessionGitSurface' as never);

        await act(async () => {
            gitSurface.props.onOpenCommit('abc1234 extra');
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(switchSurface).toHaveBeenCalledWith('tabs');
        expect(probe.props.scopeState?.details?.tabs).toEqual([
            expect.objectContaining({
                key: 'commit:abc1234',
                resource: { kind: 'commit', sha: 'abc1234' },
            }),
        ]);
    });

    it('opens review details on the internal details tab without pushing a sibling stack route', async () => {
        const switchSurface = vi.fn();
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceNavigationProvider value={{ switchSurface }}>
                    <SessionCockpitSurfaceScreen
                        sessionId="s_1"
                        scopeId="session:s_1"
                        surface="git"
                        routeServerId="server-b"
                        terminalTabAvailable
                    />
                </SessionCockpitSurfaceNavigationProvider>
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        const gitSurface = screen.tree.findByType('SessionGitSurface' as never);

        await act(async () => {
            gitSurface.props.onOpenReviewAllChanges();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(switchSurface).toHaveBeenCalledWith('tabs');
        expect(probe.props.scopeState?.details?.tabs).toEqual([
            expect.objectContaining({
                key: 'scmReview:working',
                resource: { kind: 'scmReview', scope: 'working' },
            }),
        ]);
    });

    it('opens stash details on the internal details tab without pushing a sibling stack route', async () => {
        const switchSurface = vi.fn();
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceNavigationProvider value={{ switchSurface }}>
                    <SessionCockpitSurfaceScreen
                        sessionId="s_1"
                        scopeId="session:s_1"
                        surface="git"
                        routeServerId="server-b"
                        terminalTabAvailable
                    />
                </SessionCockpitSurfaceNavigationProvider>
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        const gitSurface = screen.tree.findByType('SessionGitSurface' as never);

        await act(async () => {
            gitSurface.props.onOpenStashDetails();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(switchSurface).toHaveBeenCalledWith('tabs');
        expect(probe.props.scopeState?.details?.tabs).toEqual([
            expect.objectContaining({
                key: 'scmStash',
                resource: { kind: 'scmStash' },
            }),
        ]);
    });

    it('opens a new terminal details tab on the internal details surface', async () => {
        const switchSurface = vi.fn();
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceNavigationProvider value={{ switchSurface }}>
                    <SessionCockpitSurfaceScreen
                        sessionId="s_1"
                        scopeId="session:s_1"
                        surface="terminal"
                        routeServerId="server-b"
                        terminalTabAvailable
                    />
                </SessionCockpitSurfaceNavigationProvider>
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        const terminalSurface = screen.tree.findByType('SessionTerminalSurface' as never);

        await act(async () => {
            terminalSurface.props.onOpenNewTerminalTab();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(switchSurface).toHaveBeenCalledWith('tabs');
        expect(probe.props.scopeState?.details?.tabs).toEqual([
            expect.objectContaining({
                kind: 'terminal',
                resource: expect.objectContaining({ kind: 'terminal' }),
            }),
        ]);
    });

    it('renders a validated plugin mobile surface through the right-sidebar placement host', async () => {
        pluginProjectionState.value = {
            pluginUiProjection: createPluginProjection(),
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
        };
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceScreen
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="plugin:review:review"
                    routeServerId="server-b"
                    terminalTabAvailable
                />
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        const host = screen.tree.findByType('PluginSurfacePlacementHostStub' as never);
        expect(host.props.placement.descriptorId).toBe('review-panel');
        expect(host.props.machineId).toBe('machine-1');
        expect(host.props.serverId).toBe('server-1');
        expect(screen.tree.findByType('PaneScopeProbe' as never).props.scopeState?.right).toEqual(expect.objectContaining({
            isOpen: true,
            activeTabId: 'plugin:review:review',
        }));
    });
});
