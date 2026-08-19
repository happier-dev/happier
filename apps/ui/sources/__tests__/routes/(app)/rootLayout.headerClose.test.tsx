import * as React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

const routerBackSpy = vi.hoisted(() => vi.fn());
const safeRouterBackSpy = vi.hoisted(() => vi.fn());
const keyboardDismissSpy = vi.hoisted(() => vi.fn());
const windowState = vi.hoisted(() => ({
    width: 800,
    height: 600,
}));
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

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const reactNative = await createReactNativeWebMock({
        useWindowDimensions: () => ({ width: windowState.width, height: windowState.height }),
    });
    return {
        ...reactNative,
        Keyboard: {
            ...reactNative.Keyboard,
            dismiss: keyboardDismissSpy,
        },
        Platform: {
            ...reactNative.Platform,
            get OS() {
                return platformState.os;
            },
        },
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
    getTabActiveServerId: () => null,
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    isSameServerUrl: () => true,
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
    commitWebServerUrlOverride: vi.fn(async () => undefined),
    readWebServerUrlOverrideFromLocation: () => null,
}));

vi.mock('@/utils/path/terminalConnectUrl', () => ({
    buildTerminalConnectWebHref: () => '/terminal/connect',
}));

vi.mock('@/hooks/ui/useWebInitialRouteReconcile', () => ({
    useWebInitialRouteReconcile: vi.fn(),
}));

vi.mock('@/hooks/server/useHappierVoiceSupport', () => ({
    useHappierVoiceSupport: () => true,
}));

vi.mock('@/hooks/session/sessionRouteServerScope', () => ({
    buildScopedSessionRouteHref: () => '/session/test',
}));

vi.mock('@/utils/navigation/createSocialStackScreenOptions', () => ({
    createFriendsStackScreenOptions: () => ({}),
    createInboxStackScreenOptions: () => ({}),
}));

vi.mock('@/activity/badges/ActivityBadgeRuntime', () => ({
    ActivityBadgeRuntime: () => React.createElement('ActivityBadgeRuntime'),
}));

vi.mock('@/activity/notifications/runtime/ActivityLocalNotificationRuntime', () => ({
    ActivityLocalNotificationRuntime: () => React.createElement('ActivityLocalNotificationRuntime'),
}));

vi.mock('@/desktop/tray/DesktopTrayRuntime', () => ({
    DesktopTrayRuntime: () => React.createElement('DesktopTrayRuntime'),
}));

vi.mock('@/changelog/releaseNotes', () => ({
    ReleaseNotesAutoShowMount: () => React.createElement('ReleaseNotesAutoShowMount'),
}));

vi.mock('@/activity/notifications/runtime/useNotificationResponseRouting', () => ({
    useNotificationResponseRouting: vi.fn(),
}));

vi.mock('@/components/navigation/createAppStackScreenOptions', () => ({
    createAppStackScreenOptions: () => ({}),
}));

vi.mock('@/components/navigation/mobile/chrome/MobileBottomChromeHost', () => ({
    MobileBottomChromeHost: () => React.createElement('MobileBottomChromeHost'),
}));

vi.mock('@/components/pets/runtime/DesktopPetOverlayRuntimeMount', () => ({
    DesktopPetOverlayRuntimeMount: () => React.createElement('DesktopPetOverlayRuntimeMount'),
}));

vi.mock('@/components/pets/runtime/PetAppShellCompanionMount', () => ({
    PetAppShellCompanionMount: () => React.createElement('PetAppShellCompanionMount'),
}));

vi.mock('@/components/pets/desktop/runtime/isDesktopPetOverlayWindowContext', () => ({
    isDesktopPetOverlayWindowContext: () => false,
}));

vi.mock('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry', () => ({
    SessionCockpitChromeRegistryProvider: (props: { children?: React.ReactNode }) => React.createElement('SessionCockpitChromeRegistryProvider', null, props.children),
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
        keyboardDismissSpy.mockReset();
        platformState.os = 'ios';
        windowState.width = 800;
        windowState.height = 600;
        stackNavigationState.index = 0;
        stackNavigationState.routes = [{ key: 'current-route' }];
    });

    it('exposes a native close affordance for the new-session modal', async () => {
        const { default: RootLayout } = await import('@/app/(app)/_layout');

        const screen = await renderScreen(<RootLayout />);

        const options = getStackScreenOptions(screen, 'new/index');
        const headerRight = options.headerRight as (() => React.ReactNode) | undefined;
        expect(headerRight).toBeTypeOf('function');

        const renderedHeader = await renderScreen(<>{headerRight?.()}</>);
        const closeButton = renderedHeader.tree.root
            .findAllByProps({ testID: 'new-session-cancel' })
            .find((node) => node.props.accessibilityRole === 'button');
        expect(closeButton).toBeTruthy();

        expect(closeButton?.props.accessibilityLabel).toBe('common.cancel');
        await pressTestInstanceAsync(closeButton!);
        expect(safeRouterBackSpy).toHaveBeenCalledWith({
            router: expect.objectContaining({
                back: routerBackSpy,
            }),
            navigation: stackNavigationMock,
            fallbackHref: '/',
        });
    });

    it('prevents a direct desktop-web modal backdrop dismissal and exposes a deterministic close', async () => {
        platformState.os = 'web';
        const { default: RootLayout } = await import('@/app/(app)/_layout');

        const screen = await renderScreen(<RootLayout />);

        const options = getStackScreenOptions(screen, 'new/index');
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
            router: expect.objectContaining({
                back: routerBackSpy,
            }),
            navigation: stackNavigationMock,
            fallbackHref: '/',
        });
    });

    it('keeps desktop-web modal backdrop dismissal enabled when /new has a prior stack route', async () => {
        platformState.os = 'web';
        stackNavigationState.index = 1;
        stackNavigationState.routes = [{ key: 'index-route' }, { key: 'new-route' }];
        stackNavigationMock.canGoBack.mockReturnValue(true);
        const { default: RootLayout } = await import('@/app/(app)/_layout');

        const screen = await renderScreen(<RootLayout />);

        const options = getStackScreenOptions(screen, 'new/index');
        expect(options.gestureEnabled).toBe(true);
    });

    it('does not duplicate the route-level new-session close button on mobile web', async () => {
        platformState.os = 'web';
        windowState.width = 390;
        const { default: RootLayout } = await import('@/app/(app)/_layout');

        const screen = await renderScreen(<RootLayout />);

        const options = getStackScreenOptions(screen, 'new/index');
        const headerRight = options.headerRight as (() => React.ReactNode) | undefined;
        expect(headerRight).toBeTypeOf('function');

        const renderedHeader = await renderScreen(<>{headerRight?.()}</>);
        expect(renderedHeader.tree.root.findAllByProps({ testID: 'new-session-cancel' })).toHaveLength(0);
    });

    it('dismisses the keyboard when the native new-session header title is pressed', async () => {
        const { default: RootLayout } = await import('@/app/(app)/_layout');

        const screen = await renderScreen(<RootLayout />);

        const options = getStackScreenOptions(screen, 'new/index');
        const headerTitle = options.headerTitle as (() => React.ReactNode) | undefined;
        expect(headerTitle).toBeTypeOf('function');

        const renderedHeaderTitle = await renderScreen(<>{headerTitle?.()}</>);
        const dismissTarget = renderedHeaderTitle.tree.root
            .findAllByProps({ testID: 'new-session-header-keyboard-dismiss' })
            .at(0);
        expect(dismissTarget).toBeTruthy();

        await pressTestInstanceAsync(dismissTarget!);
        expect(keyboardDismissSpy).toHaveBeenCalledTimes(1);
    });

});
