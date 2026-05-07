import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { getStyleValue, installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.fn();
const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();
let mockSessionId = 'session-1';
let mockServerId: string | undefined;
let isFocused = true;
let canGoBack = true;
let terminalFeatureEnabled = true;
let terminalFeatureEnabledForServerId: string | null = null;
let resolvedTerminalServerId: string | null = 'server-session';
let terminalDockLocation = 'sidebar';
let deviceType: 'phone' | 'tablet' | 'desktop' = 'desktop';
let mobileWorkspaceExperience: 'classic' | 'cockpit' = 'classic';
let safeAreaInsets = { top: 47, right: 0, bottom: 34, left: 0 };

const openRightSpy = vi.fn();
const closeRightSpy = vi.fn();
const setRightTabSpy = vi.fn();
const ensureSessionVisibleSpy = vi.fn((_sessionId: string) => Promise.resolve());
const hydrateSpy = vi.fn((sessionId: string, _tag: string, options?: { serverId?: string }) => {
    ensureSessionVisibleSpy(sessionId);
    return options;
});

let scopeState: any = {
    right: { isOpen: false, activeTabId: null, tabState: {} },
    details: null,
};

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => isFocused,
}));

installSessionRouteCommonModuleMocks({
    safeAreaInsets: () => safeAreaInsets,
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            ActivityIndicator: 'ActivityIndicator',
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: {
                back: routerBackSpy,
                push: routerPushSpy,
                replace: routerReplaceSpy,
                setParams: vi.fn(),
            },
        });

        return {
            ...routerMock.module,
            useLocalSearchParams: () => ({ id: mockSessionId, serverId: mockServerId }),
            useGlobalSearchParams: () => ({ id: mockSessionId, serverId: mockServerId }),
            useNavigation: () => ({ canGoBack: () => canGoBack }),
        };
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                // Narrow boundary fixture: this route only reads cockpit and embedded-terminal dock settings.
                useSetting: ((key: string) => {
                    if (key === 'mobileWorkspaceExperienceV1') return mobileWorkspaceExperience;
                    return null;
                }) as any,
                useSettingMutable: ((key: string) => [
                    key === 'mobileWorkspaceExperienceV1' ? mobileWorkspaceExperience : null,
                    vi.fn(),
                ]) as any,
                useLocalSetting: ((key: string) => {
                    if (key === 'embeddedTerminalDockLocation') return terminalDockLocation;
                    if (key === 'sessionLastMobileSurfaceBySessionId') return {};
                    return null;
                }) as any,
            },
        });
    },
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeId: `session:${mockSessionId}`,
        scopeState,
        openRight: openRightSpy,
        closeRight: closeRightSpy,
        setRightTab: setRightTabSpy,
        setRightTabState: vi.fn(),
        openDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
        pinDetailsTab: vi.fn(),
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
    }),
}));

vi.mock('@/components/sessions/panes/SessionRightPanel', () => ({
    SessionRightPanel: (props: any) => React.createElement('SessionRightPanel', props),
}));

vi.mock('@/components/workspaceCockpit/session/SessionCockpitShell', () => ({
    SessionCockpitShell: (props: any) => React.createElement('SessionCockpitShell', props),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, tag: string, options?: { serverId?: string }) => {
        hydrateSpy(sessionId, tag, options);
        return true;
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (_featureId: string, scope?: { scopeKind?: string; serverId?: string | null }) =>
        terminalFeatureEnabled
        && (
            terminalFeatureEnabledForServerId == null
            || (scope?.scopeKind === 'spawn' && scope.serverId === terminalFeatureEnabledForServerId)
        ),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceType,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => resolvedTerminalServerId,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionVisibleForMessageRoute: (sessionId: string) => ensureSessionVisibleSpy(sessionId),
    },
}));

let SessionTerminalRouteScreen: React.ComponentType<any>;

describe('/session/[id]/terminal', () => {
    beforeAll(async () => {
        SessionTerminalRouteScreen = (await import('@/app/(app)/session/[id]/terminal')).default;
    }, 60_000);

    beforeEach(() => {
        mockSessionId = 'session-1';
        mockServerId = undefined;
        isFocused = true;
        canGoBack = true;
        terminalFeatureEnabled = true;
        terminalFeatureEnabledForServerId = null;
        resolvedTerminalServerId = 'server-session';
        terminalDockLocation = 'sidebar';
        deviceType = 'desktop';
        mobileWorkspaceExperience = 'classic';
        safeAreaInsets = { top: 47, right: 0, bottom: 34, left: 0 };
        scopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            details: null,
        };
        openRightSpy.mockClear();
        closeRightSpy.mockClear();
        setRightTabSpy.mockClear();
        routerBackSpy.mockClear();
        routerPushSpy.mockClear();
        routerReplaceSpy.mockClear();
        ensureSessionVisibleSpy.mockClear();
        hydrateSpy.mockClear();
        vi.clearAllMocks();
    });

    afterEach(() => {
        standardCleanup();
    });

    async function renderRouteScreen() {
        return renderScreen(<SessionTerminalRouteScreen />);
    }

    it('keeps the fullscreen terminal surface inside the vertical safe area', async () => {
        const screen = await renderRouteScreen();
        const surface = screen.findByTestId('session-terminal-screen');
        if (!surface) throw new Error('Expected session terminal screen surface to render');

        expect(getStyleValue(surface.props.style, 'paddingTop')).toBe(47);
        expect(getStyleValue(surface.props.style, 'paddingBottom')).toBe(34);
    });

    it('opens the right pane with the terminal tab selected', async () => {
        const screen = await renderRouteScreen();

        const panel = screen.findByType('SessionRightPanel' as any);
        expect(panel.props.sessionId).toBe('session-1');
        expect(panel.props.scopeId).toBe('session:session-1');
        expect(panel.props.presentation).toBe('screen');
        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(setRightTabSpy).toHaveBeenCalledWith('terminal');
    });

    it('renders the session cockpit shell on phone in cockpit mode', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';

        const screen = await renderRouteScreen();

        const cockpit = screen.findByType('SessionCockpitShell' as any);
        expect(cockpit.props.sessionId).toBe('session-1');
        expect(cockpit.props.scopeId).toBe('session:session-1');
        expect(cockpit.props.surface).toBe('terminal');
        expect(cockpit.props.safeAreaPadding).toBe(false);
        expect(cockpit.props.terminalTabAvailable).toBe(true);
        const routeSurface = screen.findByTestId('session-cockpit-route-screen');
        expect(getStyleValue(routeSurface?.props.style, 'paddingTop')).toBe(0);
        expect(getStyleValue(routeSurface?.props.style, 'paddingBottom')).toBe(34);
        expect(screen.findAllByType('SessionRightPanel' as any)).toHaveLength(0);
    });

    it('re-targets the pane to terminal when an existing non-terminal tab is already active', async () => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
            details: null,
        };

        await renderRouteScreen();

        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(setRightTabSpy).toHaveBeenCalledWith('terminal');
    });

    it('hydrates the session for deep links by requesting session visibility', async () => {
        mockServerId = 'server-b';
        await renderRouteScreen();

        expect(ensureSessionVisibleSpy).toHaveBeenCalledWith('session-1');
        expect(hydrateSpy).toHaveBeenCalledWith(
            'session-1',
            'SessionTerminalRoute.ensureSessionVisible',
            { serverId: 'server-b' },
        );
    });

    it('closes by navigating back and closing the right-pane state', async () => {
        const screen = await renderRouteScreen();

        const panel = screen.findByType('SessionRightPanel' as any);
        await act(async () => {
            panel.props.onRequestClose();
        });

        expect(closeRightSpy).toHaveBeenCalled();
        expect(routerBackSpy).toHaveBeenCalled();
    });

    it('falls back to the parent session route when there is no back stack', async () => {
        mockServerId = 'server-b';
        canGoBack = false;

        const screen = await renderRouteScreen();

        const panel = screen.findByType('SessionRightPanel' as any);
        await act(async () => {
            panel.props.onRequestClose();
        });

        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1?serverId=server-b');
    });

    it('does not open the terminal pane when the route is unavailable and is redirecting away', async () => {
        terminalFeatureEnabled = false;

        await renderRouteScreen();

        expect(openRightSpy).not.toHaveBeenCalled();
        expect(setRightTabSpy).not.toHaveBeenCalled();
    });

    it('keeps the terminal route available when the viewed session server supports embedded terminal', async () => {
        mockServerId = 'server-session';
        terminalFeatureEnabledForServerId = 'server-session';

        await renderRouteScreen();

        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(setRightTabSpy).toHaveBeenCalledWith('terminal');
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('opens the terminal route when the viewed session server enables terminal', async () => {
        mockServerId = 'server-b';
        terminalFeatureEnabled = true;
        terminalFeatureEnabledForServerId = 'server-b';

        await renderRouteScreen();

        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(setRightTabSpy).toHaveBeenCalledWith('terminal');
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('pushes the details route again when the session id changes even if the details key is unchanged', async () => {
        mockServerId = 'server-b';
        scopeState = {
            right: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: {
                isOpen: true,
                activeTabKey: 'file:README.md',
                tabs: [
                    {
                        key: 'file:README.md',
                        kind: 'file',
                        resource: { path: 'README.md' },
                    },
                ],
            },
        };

        const screen = await renderRouteScreen();

        expect(routerPushSpy).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).toHaveBeenLastCalledWith('/session/session-1/details?serverId=server-b&details=file&path=README.md&sourceSurface=terminal');

        mockSessionId = 'session-2';

        await screen.update(<SessionTerminalRouteScreen />);

        expect(routerPushSpy).toHaveBeenCalledTimes(2);
        expect(routerPushSpy).toHaveBeenLastCalledWith('/session/session-2/details?serverId=server-b&details=file&path=README.md&sourceSurface=terminal');
    });

    it('stays on the terminal route in cockpit mode when a details tab opens', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        scopeState = {
            right: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: {
                isOpen: true,
                activeTabKey: 'file:README.md',
                tabs: [{ key: 'file:README.md', kind: 'file', resource: { path: 'README.md' } }],
            },
        };

        await renderRouteScreen();

        expect(routerPushSpy).not.toHaveBeenCalled();
    });
});
