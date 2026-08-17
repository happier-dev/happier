import * as React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

const routerBackSpy = vi.hoisted(() => vi.fn());
const safeRouterBackSpy = vi.hoisted(() => vi.fn());
const stackNavigationState = vi.hoisted(() => ({
    index: 0,
    routes: [{ key: 'current-route' }],
}));
const stackNavigationMock = vi.hoisted(() => ({
    navigate: vi.fn(),
    canGoBack: vi.fn(() => false),
    goBack: vi.fn(),
    getState: vi.fn(() => stackNavigationState),
}));
const platformState = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'web',
}));
const settingState = vi.hoisted(() => ({
    newSessionPresentationModeV1: 'auto' as 'auto' | 'screen' | 'modal',
}));
const deviceTypeState = vi.hoisted(() => ({
    value: 'tablet' as 'phone' | 'tablet',
}));


vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const reactNative = await createReactNativeWebMock();
    return {
        ...reactNative,
        Platform: {
            ...reactNative.Platform,
            get OS() {
                return platformState.os;
            },
        },
    };
});

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        useDeviceType: () => deviceTypeState.value,
    };
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            back: routerBackSpy,
        },
    }).module;
});

vi.mock('@/utils/navigation/safeRouterBack', () => ({
    safeRouterBack: (...args: unknown[]) => safeRouterBackSpy(...args),
}));

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: true,
        refreshFromActiveServer: vi.fn(),
    }),
}));

vi.mock('@/auth/routing/authRouting', () => ({
    isPublicRouteForUnauthenticated: () => false,
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ isReady: true }),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => null,
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string | null | undefined) => value ?? null,
    upsertActivateAndSwitchServer: vi.fn(),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => null,
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: vi.fn(),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: { children?: React.ReactNode }) => React.createElement('Text', null, props.children),
}));

vi.mock('@/sync/domains/server/url/bootstrapActiveServerFromWebLocation', () => ({
    bootstrapActiveServerFromWebLocation: () => null,
}));

vi.mock('@/sync/domains/server/url/shouldHoldAuthenticatedShellForWebServerOverride', () => ({
    shouldHoldAuthenticatedShellForWebServerOverride: () => false,
}));

vi.mock('@/sync/domains/server/url/consumeLegacySessionDeepLinkFromWebLocation', () => ({
    consumeLegacySessionDeepLinkFromWebLocation: () => null,
}));

vi.mock('@/sync/domains/server/url/resolveAuthenticatedWebServerUrlOverrideAction', () => ({
    resolveAuthenticatedWebServerUrlOverrideAction: () => ({ kind: 'none' }),
}));

vi.mock('@/utils/path/terminalConnectUrl', () => ({
    buildTerminalConnectWebHref: () => '/terminal/connect',
    isTerminalConnectWebPathname: () => false,
}));

vi.mock('@/hooks/ui/useWebInitialRouteReconcile', () => ({
    useWebInitialRouteReconcile: vi.fn(),
}));

vi.mock('@/hooks/server/useHappierVoiceSupport', () => ({
    useHappierVoiceSupport: () => true,
}));

vi.mock('@/hooks/session/sessionRouteAuthRecovery', () => ({
    isSessionRouteInAuthRecoverySubtree: () => false,
    resolveSessionRouteAuthRecoveryState: () => ({ baseHref: null }),
    shouldNormalizeSessionRouteToAuthRecoveryBase: () => false,
}));

vi.mock('@/utils/navigation/createSocialStackScreenOptions', () => ({
    createFriendsStackScreenOptions: () => ({}),
    createInboxStackScreenOptions: () => ({}),
}));

vi.mock('@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext', () => ({
    isDesktopActivityOverlayWindowContext: () => false,
}));

vi.mock('@/activity/notifications/runtime/useNotificationResponseRouting', () => ({
    useNotificationResponseRouting: vi.fn(),
}));

vi.mock('@/utils/platform/tauri', () => ({
    invokeTauri: vi.fn(),
    isTauriDesktop: () => false,
}));

vi.mock('@/components/navigation/createAppStackScreenOptions', () => ({
    createAppStackScreenOptions: () => ({}),
}));

vi.mock('@/components/navigation/mobile/chrome/MobileBottomChromeHost', () => ({
    MobileBottomChromeHost: () => React.createElement('MobileBottomChromeHost'),
}));

vi.mock('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry', () => ({
    SessionCockpitChromeRegistryProvider: (props: { children?: React.ReactNode }) => React.createElement('SessionCockpitChromeRegistryProvider', null, props.children),
}));

vi.mock('@/components/appShell/runtime/AuthenticatedAppRuntimeMounts', () => ({
    AuthenticatedAppRuntimeMounts: () => React.createElement('AuthenticatedAppRuntimeMounts'),
}));

// The single app-shell Voice announcer is a real runtime mounted outside the runtime-mounts
// gate, so this stack-options suite gets the same treatment the gate already has: this file
// is about Stack.Screen presentation, not about standing up the Voice lifecycle.
vi.mock('@/components/voice/surface/VoiceAnnouncer', () => ({
    VoiceAnnouncer: () => React.createElement('VoiceAnnouncer'),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useEndpointConnectivity: () => ({ status: 'connected' }),
    useSyncError: () => null,
    useSetting: (key: string) => {
        if (key === 'newSessionPresentationModeV1') return settingState.newSessionPresentationModeV1;
        return undefined;
    },
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverId: 'server-1' }),
}));

function getStackScreenOptions(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    name: string,
): Record<string, unknown> {
    const stackScreen = screen.tree.root
        .findAllByType('StackScreen')
        .find((node) => node.props.name === name);
    if (!stackScreen) throw new Error(`Missing Stack.Screen ${name}`);
    const options = stackScreen.props.options as Record<string, unknown> | ((params: Record<string, unknown>) => Record<string, unknown>) | undefined;
    if (typeof options === 'function') {
        return options({ navigation: stackNavigationMock });
    }
    return options ?? {};
}

describe('app stack modal header close buttons', () => {
    beforeEach(() => {
        routerBackSpy.mockReset();
        safeRouterBackSpy.mockReset();
        stackNavigationMock.navigate.mockReset();
        stackNavigationMock.canGoBack.mockClear();
        stackNavigationMock.goBack.mockReset();
        stackNavigationMock.getState.mockClear();
        platformState.os = 'ios';
        settingState.newSessionPresentationModeV1 = 'auto';
        deviceTypeState.value = 'tablet';
        stackNavigationState.index = 0;
        stackNavigationState.routes = [{ key: 'current-route' }];
    });

    it('keeps the native new-session modal dismissal contract unchanged', async () => {
        const { default: RootLayout } = await import('@/app/(app)/_layout');
        const screen = await renderScreen(<RootLayout />);

        const options = getStackScreenOptions(screen, 'new/index');
        expect(options.gestureEnabled).toBe(true);
        expect(options.headerRight).toBeUndefined();
    });

    it('prevents a direct web modal backdrop dismissal and exposes a deterministic close', async () => {
        platformState.os = 'web';
        const { default: RootLayout } = await import('@/app/(app)/_layout');
        const screen = await renderScreen(<RootLayout />);

        const options = getStackScreenOptions(screen, 'new/index');
        expect(options.presentation).toBe('modal');
        expect(options.gestureEnabled).toBe(false);

        const headerRight = options.headerRight as (() => React.ReactNode) | undefined;
        expect(headerRight).toBeTypeOf('function');
        const renderedHeader = await renderScreen(<>{headerRight?.()}</>);
        const closeButton = renderedHeader.tree.root
            .findAllByProps({ testID: 'new-session-cancel' })
            .find((node) => node.props.accessibilityRole === 'button');
        expect(closeButton).toBeTruthy();

        await pressTestInstanceAsync(closeButton!);
        expect(safeRouterBackSpy).toHaveBeenCalledWith({
            router: expect.objectContaining({ back: routerBackSpy }),
            navigation: stackNavigationMock,
            fallbackHref: '/',
        });
    });

    it('keeps web modal backdrop dismissal enabled when /new has a prior stack route', async () => {
        platformState.os = 'web';
        stackNavigationState.index = 1;
        stackNavigationState.routes = [{ key: 'index-route' }, { key: 'new-route' }];
        stackNavigationMock.canGoBack.mockReturnValue(true);
        const { default: RootLayout } = await import('@/app/(app)/_layout');
        const screen = await renderScreen(<RootLayout />);

        const options = getStackScreenOptions(screen, 'new/index');
        expect(options.presentation).toBe('modal');
        expect(options.gestureEnabled).toBe(true);
    });

    it('presents the new-session route as a stack modal on web by default', async () => {
        platformState.os = 'web';
        const { default: RootLayout } = await import('@/app/(app)/_layout');

        const screen = await renderScreen(<RootLayout />);

        const options = getStackScreenOptions(screen, 'new/index');
        expect(options.presentation).toBe('modal');
    });

    it('presents the new-session route as a stack modal on web when requested', async () => {
        platformState.os = 'web';
        settingState.newSessionPresentationModeV1 = 'modal';
        const { default: RootLayout } = await import('@/app/(app)/_layout');

        const screen = await renderScreen(<RootLayout />);

        const options = getStackScreenOptions(screen, 'new/index');
        expect(options.presentation).toBe('modal');
    });

    it('presents the new-session route as a regular screen on iOS when requested', async () => {
        platformState.os = 'ios';
        settingState.newSessionPresentationModeV1 = 'screen';
        const { default: RootLayout } = await import('@/app/(app)/_layout');

        const screen = await renderScreen(<RootLayout />);

        const options = getStackScreenOptions(screen, 'new/index');
        expect(options.presentation).toBeUndefined();
    });

    it('uses deterministic back fallback for the direct-session browse close button', async () => {
        const { default: RootLayout } = await import('@/app/(app)/_layout');

        const screen = await renderScreen(<RootLayout />);

        const options = getStackScreenOptions(screen, 'direct/browse');
        const headerRight = options.headerRight as (() => React.ReactNode) | undefined;
        expect(headerRight).toBeTypeOf('function');

        const renderedHeader = await renderScreen(<>{headerRight?.()}</>);
        const closeButton = renderedHeader.tree.root
            .findAllByProps({ testID: 'direct-session-browse-cancel' })
            .find((node) => node.props.accessibilityRole === 'button');
        expect(closeButton).toBeTruthy();

        await pressTestInstanceAsync(closeButton!);
        expect(safeRouterBackSpy).toHaveBeenCalledWith({
            router: expect.objectContaining({
                back: routerBackSpy,
            }),
            navigation: stackNavigationMock,
            fallbackHref: '/',
        });
    });

    it('uses deterministic back fallback for the canonical external-session browse close button', async () => {
        const { default: RootLayout } = await import('@/app/(app)/_layout');
        const screen = await renderScreen(<RootLayout />);
        const options = getStackScreenOptions(screen, 'external/browse');
        const headerRight = options.headerRight as (() => React.ReactNode) | undefined;
        const renderedHeader = await renderScreen(<>{headerRight?.()}</>);
        const closeButton = renderedHeader.tree.root
            .findAllByProps({ testID: 'external-session-browse-cancel' })
            .find((node) => node.props.accessibilityRole === 'button');

        expect(closeButton).toBeTruthy();
        await pressTestInstanceAsync(closeButton!);
        expect(safeRouterBackSpy).toHaveBeenCalledWith({
            router: expect.objectContaining({ back: routerBackSpy }),
            navigation: stackNavigationMock,
            fallbackHref: '/',
        });
    });

    it('always exposes one accessible deterministic exit for Session Info', async () => {
        const { default: RootLayout } = await import('@/app/(app)/_layout');
        const screen = await renderScreen(<RootLayout />);
        const options = getStackScreenOptions(screen, 'session/[id]/info');

        expect(options.headerBackVisible).toBe(false);
        expect((options.headerLeft as (() => React.ReactNode) | undefined)?.()).toBeNull();

        const headerRight = options.headerRight as (() => React.ReactNode) | undefined;
        expect(headerRight).toBeTypeOf('function');
        const renderedHeader = await renderScreen(<>{headerRight?.()}</>);
        const closeButton = renderedHeader.tree.root
            .findAllByProps({ testID: 'session-info-close' })
            .find((node) => node.props.accessibilityRole === 'button');

        expect(closeButton).toBeTruthy();
        expect(closeButton?.props.accessibilityLabel).toBe('common.close');
        await pressTestInstanceAsync(closeButton!);
        expect(safeRouterBackSpy).toHaveBeenCalledWith({
            router: expect.objectContaining({ back: routerBackSpy }),
            navigation: stackNavigationMock,
            fallbackHref: '/',
        });
    });

    it('presents settings as an animated stack modal on web tablet/desktop layouts', async () => {
        platformState.os = 'web';
        deviceTypeState.value = 'tablet';
        const { default: RootLayout } = await import('@/app/(app)/_layout');

        const screen = await renderScreen(<RootLayout />);

        const settingsOptions = getStackScreenOptions(screen, 'settings');
        expect(settingsOptions.presentation).toBe('modal');
        // Modal mode animates in (not the instant 'none' the phone tab uses).
        expect(settingsOptions.animation).toBeUndefined();
    });

    it('presents settings as a contained modal on iOS tablets', async () => {
        platformState.os = 'ios';
        deviceTypeState.value = 'tablet';
        const { default: RootLayout } = await import('@/app/(app)/_layout');

        const screen = await renderScreen(<RootLayout />);

        expect(getStackScreenOptions(screen, 'settings').presentation).toBe('containedModal');
    });

    it('keeps settings as a non-animated full-screen tab on phones (reached via the bottom tab bar)', async () => {
        platformState.os = 'web';
        deviceTypeState.value = 'phone';
        const { default: RootLayout } = await import('@/app/(app)/_layout');

        const screen = await renderScreen(<RootLayout />);

        const settingsOptions = getStackScreenOptions(screen, 'settings');
        expect(settingsOptions.presentation).toBeUndefined();
        // Phone keeps the instant tab switch — animation must remain suppressed.
        expect(settingsOptions.animation).toBe('none');
    });
});
