import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { getStyleValue, installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.fn();
const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();
let mockSessionId = 'session-1';
let mockServerId: string | undefined;
let isFocused = true;
let canGoBack = true;
let deviceType: 'phone' | 'tablet' | 'desktop' = 'desktop';
let mobileWorkspaceExperience: 'classic' | 'cockpit' = 'classic';
let safeAreaInsets = { top: 47, right: 0, bottom: 34, left: 0 };

const openRightSpy = vi.fn();
const closeRightSpy = vi.fn();
const setRightTabSpy = vi.fn();
const setLastMobileSurfaceBySessionIdSpy = vi.fn();
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
                useSetting: ((key: string) => {
                    if (key === 'mobileWorkspaceExperienceV1') return mobileWorkspaceExperience;
                    return null;
                }) as any,
                useSettingMutable: ((key: string) => [
                    key === 'mobileWorkspaceExperienceV1' ? mobileWorkspaceExperience : null,
                    vi.fn(),
                ]) as any,
                useLocalSetting: ((key: string) => {
                    if (key === 'sessionLastMobileSurfaceBySessionId') return {};
                    return null;
                }) as any,
                useLocalSettingMutable: ((key: string) => [
                    key === 'sessionLastMobileSurfaceBySessionId' ? {} : null,
                    key === 'sessionLastMobileSurfaceBySessionId' ? setLastMobileSurfaceBySessionIdSpy : vi.fn(),
                ]) as any,
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

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceType,
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, tag: string, options?: { serverId?: string }) => {
        hydrateSpy(sessionId, tag, options);
        return true;
    },
}));

let SessionGitRouteScreen: React.ComponentType<any>;

describe('/session/[id]/git', () => {
    beforeAll(async () => {
        SessionGitRouteScreen = (await import('@/app/(app)/session/[id]/git')).default;
    }, 60_000);

    beforeEach(() => {
        mockSessionId = 'session-1';
        mockServerId = undefined;
        isFocused = true;
        canGoBack = true;
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
        setLastMobileSurfaceBySessionIdSpy.mockClear();
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
        return renderScreen(<SessionGitRouteScreen />);
    }

    it('renders the shared SessionRightPanel fullscreen and opens the git tab in classic mode', async () => {
        const screen = await renderRouteScreen();
        const surface = screen.findByTestId('session-git-screen');
        if (!surface) throw new Error('Expected session git screen surface to render');

        const panel = screen.findByType('SessionRightPanel' as any);
        expect(panel.props.sessionId).toBe('session-1');
        expect(panel.props.scopeId).toBe('session:session-1');
        expect(panel.props.presentation).toBe('screen');
        expect(getStyleValue(surface.props.style, 'paddingTop')).toBe(47);
        expect(getStyleValue(surface.props.style, 'paddingBottom')).toBe(34);
        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'git' });
        expect(setRightTabSpy).toHaveBeenCalledWith('git');
    });

    it('renders the session cockpit shell on phone in cockpit mode', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        mockServerId = 'server-b';

        const screen = await renderRouteScreen();

        const cockpit = screen.findByType('SessionCockpitShell' as any);
        expect(cockpit.props.sessionId).toBe('session-1');
        expect(cockpit.props.scopeId).toBe('session:session-1');
        expect(cockpit.props.surface).toBe('git');
        expect(cockpit.props.safeAreaPadding).toBe(false);
        expect(cockpit.props.routeServerId).toBe('server-b');
        const routeSurface = screen.findByTestId('session-cockpit-route-screen');
        expect(getStyleValue(routeSurface?.props.style, 'paddingTop')).toBe(0);
        expect(getStyleValue(routeSurface?.props.style, 'paddingBottom')).toBe(34);
        expect(screen.findAllByType('SessionRightPanel' as any)).toHaveLength(0);
    });

    it('does not persist the mobile surface while a stacked git route is not focused', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        isFocused = false;

        await renderRouteScreen();

        expect(setLastMobileSurfaceBySessionIdSpy).not.toHaveBeenCalled();
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

    it('stays on the git route in cockpit mode when a details tab opens', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: {
                isOpen: true,
                tabs: [{ key: 'file:README.md', kind: 'file', resource: { kind: 'file', path: 'README.md' } }],
                activeTabKey: 'file:README.md',
                tabState: {},
            },
        };

        await renderRouteScreen();

        expect(routerPushSpy).not.toHaveBeenCalled();
    });
});
