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
let terminalDockLocation = 'sidebar';
let deviceType: 'phone' | 'tablet' | 'desktop' = 'desktop';
let mobileWorkspaceExperience: 'classic' | 'cockpit' = 'classic';

const openRightSpy = vi.fn();
const closeRightSpy = vi.fn();
const setRightTabSpy = vi.fn();
const ensureSessionVisibleSpy = vi.fn((_sessionId: string) => Promise.resolve());

let scopeState: any = {
    right: { isOpen: false, activeTabId: null, tabState: {} },
    details: null,
};

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => isFocused,
}));

installSessionRouteCommonModuleMocks({
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
    safeAreaInsets: {
        top: 19,
        bottom: 29,
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                // Narrow boundary fixture: this route only reads cockpit and embedded-terminal dock settings.
                useSetting: ((key: string) => (key === 'mobileWorkspaceExperienceV1' ? mobileWorkspaceExperience : null)) as any,
                useLocalSetting: ((key: string) => {
                    if (key === 'embeddedTerminalDockLocation') {
                        return terminalDockLocation;
                    }
                    if (key === 'mobileWorkspaceExperienceV1') {
                        throw new Error('mobileWorkspaceExperienceV1 must use synced account settings');
                    }
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
    useHydrateSessionForRoute: (sessionId: string) => {
        ensureSessionVisibleSpy(sessionId);
        return { kind: 'available', sessionId };
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => terminalFeatureEnabled,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceType,
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
        terminalDockLocation = 'sidebar';
        deviceType = 'desktop';
        mobileWorkspaceExperience = 'classic';
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
        vi.clearAllMocks();
    });

    afterEach(() => {
        standardCleanup();
    });

    async function renderRouteScreen() {
        return renderScreen(<SessionTerminalRouteScreen />);
    }

    it('opens the right pane with the terminal tab selected', async () => {
        const screen = await renderRouteScreen();

        const root = screen.tree.root.findAll((node) => String(node.type) === 'View' && node.props.testID === 'session-terminal-screen')[0];
        expect(root).toBeTruthy();
        const panel = screen.findByType('SessionRightPanel' as any);
        expect(panel.props.sessionId).toBe('session-1');
        expect(panel.props.scopeId).toBe('session:session-1');
        expect(panel.props.presentation).toBe('screen');
        expect(getStyleValue(root, 'paddingTop')).toBe(19);
        expect(getStyleValue(root, 'paddingBottom')).toBe(29);
        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(setRightTabSpy).toHaveBeenCalledWith('terminal');
    });

    it('renders the session cockpit shell on phone in cockpit mode', async () => {
        mobileWorkspaceExperience = 'cockpit';
        deviceType = 'phone';
        mockServerId = 'server-b';

        const screen = await renderRouteScreen();

        const cockpit = screen.findByType('SessionCockpitShell' as any);
        expect(cockpit.props.sessionId).toBe('session-1');
        expect(cockpit.props.routeServerId).toBe('server-b');
        expect(cockpit.props.scopeId).toBe('session:session-1');
        expect(cockpit.props.surface).toBe('terminal');
        expect(cockpit.props.safeAreaPadding).toBe(false);
        const root = screen.tree.root.findAll((node) => String(node.type) === 'View' && node.props.testID === 'session-cockpit-route-screen')[0];
        expect(root).toBeTruthy();
        expect(getStyleValue(root, 'paddingTop')).toBe(0);
        expect(getStyleValue(root, 'paddingBottom')).toBe(29);
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
        await renderRouteScreen();

        expect(ensureSessionVisibleSpy).toHaveBeenCalledWith('session-1');
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
        canGoBack = false;

        const screen = await renderRouteScreen();

        const panel = screen.findByType('SessionRightPanel' as any);
        await act(async () => {
            panel.props.onRequestClose();
        });

        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1');
    });

    it('does not open the terminal pane when the route is unavailable and is redirecting away', async () => {
        terminalFeatureEnabled = false;

        await renderRouteScreen();

        expect(openRightSpy).not.toHaveBeenCalled();
        expect(setRightTabSpy).not.toHaveBeenCalled();
    });

    it('stays on the terminal route in cockpit mode when a details tab opens', async () => {
        mobileWorkspaceExperience = 'cockpit';
        deviceType = 'phone';
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

        await renderRouteScreen();

        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('pushes the details route again when the session id changes even if the details key is unchanged', async () => {
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
        expect(routerPushSpy).toHaveBeenLastCalledWith({
            pathname: '/session/[id]/details',
            params: { id: 'session-1', details: 'file', path: 'README.md', sourceSurface: 'terminal' },
        });

        mockSessionId = 'session-2';

        await screen.update(<SessionTerminalRouteScreen />);

        expect(routerPushSpy).toHaveBeenCalledTimes(2);
        expect(routerPushSpy).toHaveBeenLastCalledWith({
            pathname: '/session/[id]/details',
            params: { id: 'session-2', details: 'file', path: 'README.md', sourceSurface: 'terminal' },
        });
    });
});
