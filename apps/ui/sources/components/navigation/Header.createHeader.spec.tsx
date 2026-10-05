import * as React from 'react';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const vectorIconsState = vi.hoisted(() => ({
    ionicons: 'Ionicons' as unknown,
    ioniconsFallback: 'Ionicons' as unknown,
}));
const expoImageState = vi.hoisted(() => ({
    image: 'ExpoImage' as unknown,
}));
const nativeWindowState = vi.hoisted(() => ({
    invoke: vi.fn(),
}));
const responsiveState = vi.hoisted(() => ({
    isTablet: false,
}));

function mergeStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) =>
                options.web ?? options.default ?? options.ios ?? options.android,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    get Ionicons() {
        return vectorIconsState.ionicons;
    },
}));

vi.mock('@expo/vector-icons/Ionicons', () => ({
    get Ionicons() {
        return vectorIconsState.ionicons;
    },
    get default() {
        return vectorIconsState.ioniconsFallback;
    },
}));

vi.mock('expo-image', () => ({
    get Image() {
        return expoImageState.image;
    },
}));

vi.mock('@/components/ui/layout/useChromeSafeAreaInsets', () => ({
    useChromeSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 44,
    useIsTablet: () => responsiveState.isTablet,
}));

describe('createHeader', () => {
    beforeEach(() => {
        vectorIconsState.ionicons = 'Ionicons';
        vectorIconsState.ioniconsFallback = 'Ionicons';
        expoImageState.image = 'ExpoImage';
        // Fake the native IPC boundary while the titlebar and desktop bridge stay real.
        nativeWindowState.invoke.mockReset().mockImplementation(async (command: string) =>
            command === 'desktop_get_window_chrome_policy' ? { strategy: 'custom-controls' } : true,
        );
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: nativeWindowState.invoke });
        responsiveState.isTablet = false;
        vi.resetModules();
    });
    afterEach(() => vi.unstubAllGlobals());

    it('renders a web back button and string title without crashing', async () => {
        const { createHeader } = await import('./Header');
        const navigation = {
            goBack: vi.fn(),
            getState: () => ({ index: 2 }),
        };

        const header = createHeader({
            options: {
                headerShown: true,
                headerTitle: 'Connect Terminal',
                headerTintColor: '#111111',
                headerTitleStyle: {},
                headerShadowVisible: false,
                headerTransparent: false,
                headerStyle: {},
            },
            route: { key: 'terminal-connect', name: 'terminal/connect' },
            navigation: navigation as any,
            back: { title: 'Back' },
        } as any);

        expect(header).not.toBeNull();

        const screen = await renderScreen(header as React.ReactElement);

        expect(screen.findByType('Icon' as any)).toBeTruthy();
        expect(screen.getTextContent()).toContain('Connect Terminal');
    });

    it('does not crash when Ionicons is unavailable for the default back button', async () => {
        vectorIconsState.ionicons = undefined;
        vectorIconsState.ioniconsFallback = undefined;

        const { createHeader } = await import('./Header');
        const navigation = {
            goBack: vi.fn(),
            getState: () => ({ index: 2 }),
        };

        const header = createHeader({
            options: {
                headerShown: true,
                headerTitle: 'Desktop App',
                headerTintColor: '#111111',
                headerTitleStyle: {},
                headerShadowVisible: false,
                headerTransparent: false,
                headerStyle: {},
            },
            route: { key: 'settings-desktop', name: 'desktop' },
            navigation: navigation as any,
            back: { title: 'Settings' },
        } as any);

        expect(header).not.toBeNull();
        await expect(renderScreen(header as React.ReactElement)).resolves.toBeTruthy();
    });

    it('does not crash when expo-image omits the Image export used by HeaderLogo', async () => {
        expoImageState.image = undefined;

        const { createHeader } = await import('./Header');
        const navigation = {
            goBack: vi.fn(),
            getState: () => ({ index: 2 }),
        };

        const header = createHeader({
            options: {
                headerShown: true,
                headerTitle: 'Settings',
                headerTintColor: '#111111',
                headerTitleStyle: {},
                headerShadowVisible: false,
                headerTransparent: false,
                headerStyle: {},
            },
            route: { key: 'settings-index', name: 'index' },
            navigation: navigation as any,
            back: { title: 'Back' },
        } as any);

        expect(header).not.toBeNull();
        await expect(renderScreen(header as React.ReactElement)).resolves.toBeTruthy();
    });

    it('starts window dragging from non-interactive route header space', async () => {
        const { createHeader } = await import('./Header');
        const header = createHeader({
            options: {
                headerShown: true,
                headerTitle: 'Session',
                headerTintColor: '#111111',
                headerTitleStyle: {},
                headerShadowVisible: false,
                headerTransparent: false,
                headerStyle: {},
            },
            route: { key: 'session', name: 'session' },
            navigation: {
                goBack: vi.fn(),
                getState: () => ({ index: 1 }),
            } as any,
            back: undefined,
        } as any);

        const screen = await renderScreen(header as React.ReactElement);

        expect(screen.findByTestId('desktop-route-header-content-wrapper')?.props.pointerEvents).toBe('box-none');
        expect(screen.findByTestId('desktop-route-header-content')?.props.pointerEvents).toBe('box-none');
        expect(screen.findByTestId('desktop-route-header-center')?.props.pointerEvents).toBe('box-none');
        const dragRegion = screen.findByTestId('desktop-route-header-drag-region');
        expect(mergeStyle(dragRegion?.props.style).minHeight).toBeGreaterThanOrEqual(44);
        const preventDefault = vi.fn();
        await React.act(async () => {
            dragRegion?.props.onMouseDown?.({
                buttons: 1,
                detail: 1,
                preventDefault,
                target: { closest: vi.fn(() => null) },
            });
        });
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(nativeWindowState.invoke.mock.calls.filter(([command]) => command === 'desktop_start_window_dragging')).toHaveLength(1);
    });

    it('shows the default back button at tablet stack index one', async () => {
        responsiveState.isTablet = true;
        const navigation = {
            goBack: vi.fn(),
            getState: () => ({ index: 1 }),
        };

        const { createHeader } = await import('./Header');
        const header = createHeader({
            options: {
                headerShown: true,
                headerTitle: 'Account',
                headerTintColor: '#111111',
                headerTitleStyle: {},
                headerShadowVisible: false,
                headerTransparent: false,
                headerStyle: {},
            },
            route: { key: 'settings-account', name: 'settings/account' },
            navigation,
            back: { title: 'Settings' },
        } as unknown as NativeStackHeaderProps);

        const screen = await renderScreen(header as React.ReactElement);
        const backButtons = screen.findAllByType('Pressable');

        expect(backButtons).toHaveLength(1);
        backButtons[0]?.props.onPress();
        expect(navigation.goBack).toHaveBeenCalledOnce();
    });
    it('draws no stack header for a page inside the desktop app shell, and keeps back navigation outside it', async () => {
        const { createHeader } = await import('./Header');
        const { AppShellColumnContext } = await import('@/components/navigation/shell/appRail/appShellColumnContext');
        const headerProps = (presentation?: string) => ({
            options: {
                headerShown: true,
                headerTitle: 'Plugins',
                headerTintColor: '#111111',
                headerTitleStyle: {},
                headerStyle: {},
                ...(presentation ? { presentation } : {}),
            },
            route: { key: 'plugins', name: 'plugins/index' },
            navigation: { goBack: vi.fn(), getState: () => ({ index: 2 }) } as any,
            back: { title: 'Back' },
        } as any);
        const inShell = (element: React.ReactElement, present: boolean) => (
            <AppShellColumnContext.Provider value={{ present, columnVisible: present }}>{element}</AppShellColumnContext.Provider>
        );

        // Desktop, inside the shell: the page's own header, the rail and the history arrows carry it.
        const desktop = await renderScreen(inShell(createHeader(headerProps()) as React.ReactElement, true));
        expect(desktop.getTextContent()).not.toContain('Plugins');
        expect(desktop.root.findAll((node) => (node.type as unknown) === 'Icon')).toHaveLength(0);

        // A modal presented over the shell keeps its own bar.
        const modal = await renderScreen(inShell(createHeader(headerProps('modal')) as React.ReactElement, true));
        expect(modal.getTextContent()).toContain('Plugins');

        // A phone (no shell) keeps the header and its back button.
        const phone = await renderScreen(inShell(createHeader(headerProps()) as React.ReactElement, false));
        expect(phone.getTextContent()).toContain('Plugins');
        expect(phone.root.findAll((node) => (node.type as unknown) === 'Icon').length).toBeGreaterThan(0);
    });
    it("moves a route's header actions into the page header inside the desktop shell, and keeps them in the bar elsewhere", async () => {
        const { createHeader } = await import('./Header');
        const { AppShellColumnContext } = await import('@/components/navigation/shell/appRail/appShellColumnContext');
        const { useClaimedStackHeaderActions } = await import('./stackHeaderActions');
        const { NavigationRouteContext } = await import('@react-navigation/native');
        const addFriend = vi.fn();
        const headerProps = {
            options: {
                headerShown: true,
                headerTitle: 'Friends',
                headerTintColor: '#111111',
                headerTitleStyle: {},
                headerStyle: {},
                headerRight: () => React.createElement('Pressable', { testID: 'friends-add', onPress: addFriend }),
            },
            route: { key: 'friends-manage', name: 'friends/manage' },
            navigation: { goBack: vi.fn(), getState: () => ({ index: 2 }) } as any,
            back: { title: 'Back' },
        } as any;
        function PageHeaderActions() {
            return React.createElement(React.Fragment, null, useClaimedStackHeaderActions());
        }
        const shell = (present: boolean, withPageHeader: boolean) => (
            <AppShellColumnContext.Provider value={{ present, columnVisible: present }}>
                <NavigationRouteContext.Provider value={headerProps.route}>
                    {createHeader(headerProps) as React.ReactElement}
                    {withPageHeader ? <PageHeaderActions /> : null}
                </NavigationRouteContext.Provider>
            </AppShellColumnContext.Provider>
        );
        const actions = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.root.findAll((node) => node.props?.testID === 'friends-add' && typeof node.type === 'string');

        // Desktop, page with a page header: the action is there once, and the header draws nothing.
        const desktop = await renderScreen(shell(true, true));
        expect(actions(desktop)).toHaveLength(1);
        expect(desktop.getTextContent()).not.toContain('Friends');
        desktop.tree.unmount();

        // Desktop, page without one: the header keeps an actions-only bar.
        const bare = await renderScreen(shell(true, false));
        expect(actions(bare)).toHaveLength(1);
        expect(bare.getTextContent()).not.toContain('Friends');
        bare.tree.unmount();

        // Phone: the header with its title and action, not repeated in the page.
        const phone = await renderScreen(shell(false, true));
        expect(actions(phone)).toHaveLength(1);
        expect(phone.getTextContent()).toContain('Friends');
    });
});
