import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.fn();
const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();
let mockSessionId = 'session-1';
let isFocused = true;
let canGoBack = true;
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
            useLocalSearchParams: () => ({ id: mockSessionId }),
            useGlobalSearchParams: () => ({ id: mockSessionId }),
            useNavigation: () => ({ canGoBack: () => canGoBack }),
        };
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useLocalSetting: ((key: string) => (key === 'mobileWorkspaceExperienceV1' ? mobileWorkspaceExperience : null)) as any,
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
        return true;
    },
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceType,
}));

let SessionGitRouteScreen: React.ComponentType<any>;

describe('/session/[id]/git', () => {
    beforeAll(async () => {
        SessionGitRouteScreen = (await import('@/app/(app)/session/[id]/git')).default;
    }, 60_000);

    beforeEach(() => {
        mockSessionId = 'session-1';
        isFocused = true;
        canGoBack = true;
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
        return renderScreen(<SessionGitRouteScreen />);
    }

    it('renders the shared SessionRightPanel surface fullscreen and opens the git tab', async () => {
        const screen = await renderRouteScreen();

        const panel = screen.findByType('SessionRightPanel' as never);
        expect(panel.props.sessionId).toBe('session-1');
        expect(panel.props.scopeId).toBe('session:session-1');
        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'git' });
        expect(setRightTabSpy).toHaveBeenCalledWith('git');
    });

    it('renders the session cockpit shell on phone in cockpit mode', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';

        const screen = await renderRouteScreen();

        const cockpit = screen.findByType('SessionCockpitShell' as never);
        expect(cockpit.props.sessionId).toBe('session-1');
        expect(cockpit.props.surface).toBe('git');
        expect(screen.findAllByType('SessionRightPanel' as never)).toHaveLength(0);
    });

    it('closes by navigating back and closing the right-pane state', async () => {
        const screen = await renderRouteScreen();

        const panel = screen.findByType('SessionRightPanel' as never);
        await act(async () => {
            panel.props.onRequestClose();
        });

        expect(closeRightSpy).toHaveBeenCalled();
        expect(routerBackSpy).toHaveBeenCalled();
    });

    it('stays on the git route in cockpit mode when a details tab opens', async () => {
        mobileWorkspaceExperience = 'cockpit';
        deviceType = 'phone';
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
