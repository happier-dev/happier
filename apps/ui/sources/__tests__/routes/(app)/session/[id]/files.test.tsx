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
let safeAreaInsets = { top: 47, right: 0, bottom: 34, left: 0 };
let deviceType: 'phone' | 'tablet' | 'desktop' = 'desktop';
let mobileWorkspaceExperience: 'classic' | 'cockpit' = 'classic';

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
            useNavigation: () => ({
                canGoBack: () => canGoBack,
            }),
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

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionVisibleForMessageRoute: (sessionId: string) => ensureSessionVisibleSpy(sessionId),
    },
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, tag: string, options?: { serverId?: string }) => {
        hydrateSpy(sessionId, tag, options);
        return true;
    },
}));

let SessionFilesRouteScreen: React.ComponentType<any>;

describe('/session/[id]/files', () => {
    beforeAll(async () => {
        SessionFilesRouteScreen = (await import('@/app/(app)/session/[id]/files')).default;
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
        return renderScreen(<SessionFilesRouteScreen />);
    }

    it('keeps the fullscreen files surface inside the vertical safe area', async () => {
        const screen = await renderRouteScreen();
        const surface = screen.findByTestId('session-files-screen');
        if (!surface) throw new Error('Expected session files screen surface to render');

        expect(getStyleValue(surface.props.style, 'paddingTop')).toBe(47);
        expect(getStyleValue(surface.props.style, 'paddingBottom')).toBe(34);
    });

    it('renders the shared SessionRightPanel surface fullscreen and opens the right pane state', async () => {
        const screen = await renderRouteScreen();

        const panel = screen.findByType('SessionRightPanel' as any);
        expect(panel.props.sessionId).toBe('session-1');
        expect(panel.props.scopeId).toBe('session:session-1');
        expect(panel.props.presentation).toBe('screen');
        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'files' });
        expect(setRightTabSpy).toHaveBeenCalledWith('files');
    });

    it('renders the session cockpit shell on phone in cockpit mode', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';

        const screen = await renderRouteScreen();

        const cockpit = screen.findByType('SessionCockpitShell' as any);
        expect(cockpit.props.sessionId).toBe('session-1');
        expect(cockpit.props.scopeId).toBe('session:session-1');
        expect(cockpit.props.surface).toBe('browse');
        expect(cockpit.props.safeAreaPadding).toBe(false);
        expect(cockpit.props.routeServerId).toBeUndefined();
        const routeSurface = screen.findByTestId('session-cockpit-route-screen');
        expect(getStyleValue(routeSurface?.props.style, 'paddingTop')).toBe(0);
        expect(getStyleValue(routeSurface?.props.style, 'paddingBottom')).toBe(34);
        expect(screen.findAllByType('SessionRightPanel' as any)).toHaveLength(0);
    });

    it('forces the files tab even when another right-pane tab was remembered', async () => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: null,
        };

        await renderRouteScreen();

        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'files' });
        expect(setRightTabSpy).toHaveBeenCalledWith('files');
    });

    it('does not re-target the files tab after the shared panel selects another tab', async () => {
        const screen = await renderRouteScreen();
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();

        scopeState = {
            ...scopeState,
            right: { ...scopeState.right, activeTabId: 'git' },
        };

        await screen.update(<SessionFilesRouteScreen />);

        expect(openRightSpy).not.toHaveBeenCalled();
        expect(setRightTabSpy).not.toHaveBeenCalled();
    });

    it('hydrates the session for deep links by requesting session visibility', async () => {
        mockServerId = 'server-b';
        await renderRouteScreen();

        expect(ensureSessionVisibleSpy).toHaveBeenCalledWith('session-1');
        expect(hydrateSpy).toHaveBeenCalledWith(
            'session-1',
            'SessionFilesRoute.ensureSessionVisible',
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

    it('falls back to the session route when closed without back history', async () => {
        mockServerId = 'server-b';
        canGoBack = false;
        const screen = await renderRouteScreen();

        const panel = screen.findByType('SessionRightPanel' as any);
        await act(async () => {
            panel.props.onRequestClose();
        });

        expect(closeRightSpy).toHaveBeenCalled();
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1?serverId=server-b');
    });

    it('navigates to details when a details tab is opened from the shared surface', async () => {
        mockServerId = 'server-b';
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

        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1/details?serverId=server-b&details=file&path=README.md&sourceSurface=browse');
    });

    it('stays on the browse route in cockpit mode when a details tab opens', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        scopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
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

    it('does not navigate to details when tabs exist but the details pane is closed', async () => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: { isOpen: false, tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md', tabState: {} },
        };
        await renderRouteScreen();

        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('does not navigate to details when the route is not focused', async () => {
        isFocused = false;
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: { isOpen: true, tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md', tabState: {} },
        };
        await renderRouteScreen();

        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('encodes commit details params from commitHash resources', async () => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: {
                isOpen: true,
                tabs: [{ key: 'commit:abc1234', kind: 'commit', resource: { kind: 'commit', commitHash: 'abc1234' } }],
                activeTabKey: 'commit:abc1234',
                tabState: {},
            },
        };

        await renderRouteScreen();

        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1/details?details=commit&sha=abc1234&sourceSurface=browse');
    });

    it('can navigate again when the details pane is reopened with the same active tab', async () => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: { isOpen: true, tabs: [{ key: 'scmReview:working' }], activeTabKey: 'scmReview:working', tabState: {} },
        };
        const screen = await renderRouteScreen();

        expect(routerPushSpy).toHaveBeenCalledTimes(1);

        // This route becomes unfocused while the fullscreen details route is on top.
        // Ensure we still reset the "did push" latch so the next open can navigate again.
        isFocused = false;
        scopeState = {
            ...scopeState,
            details: { ...scopeState.details, isOpen: false },
        };

        await screen.update(<SessionFilesRouteScreen />);

        isFocused = true;
        scopeState = {
            ...scopeState,
            details: { ...scopeState.details, isOpen: true },
        };

        await screen.update(<SessionFilesRouteScreen />);

        expect(routerPushSpy).toHaveBeenCalledTimes(2);
    });

    it('pushes the details route again when the session id changes even if the details key is unchanged', async () => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: {
                isOpen: true,
                activeTabKey: 'file:README.md',
                tabs: [{ key: 'file:README.md', kind: 'file', resource: { kind: 'file', path: 'README.md' } }],
                tabState: {},
            },
        };

        const screen = await renderRouteScreen();

        expect(routerPushSpy).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).toHaveBeenLastCalledWith('/session/session-1/details?details=file&path=README.md&sourceSurface=browse');

        mockSessionId = 'session-2';

        await screen.update(<SessionFilesRouteScreen />);

        expect(routerPushSpy).toHaveBeenCalledTimes(2);
        expect(routerPushSpy).toHaveBeenLastCalledWith('/session/session-2/details?details=file&path=README.md&sourceSurface=browse');
    });
});
