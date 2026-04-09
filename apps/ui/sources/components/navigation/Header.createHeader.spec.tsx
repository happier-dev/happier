import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const vectorIconsState = vi.hoisted(() => ({
    ionicons: 'Ionicons' as unknown,
    ioniconsFallback: 'Ionicons' as unknown,
}));
const expoImageState = vi.hoisted(() => ({
    image: 'ExpoImage' as unknown,
}));

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
    useIsTablet: () => false,
}));

describe('createHeader', () => {
    beforeEach(() => {
        vectorIconsState.ionicons = 'Ionicons';
        vectorIconsState.ioniconsFallback = 'Ionicons';
        expoImageState.image = 'ExpoImage';
        vi.resetModules();
    });

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

        expect(screen.findByType('Ionicons' as any)).toBeTruthy();
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

});
