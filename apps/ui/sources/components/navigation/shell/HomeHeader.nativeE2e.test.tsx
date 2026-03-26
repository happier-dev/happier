import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNavigationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: ({ name, ...props }: any) => React.createElement('Ionicons', { name, ...props }),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
    useSegments: () => [],
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: false }),
}));

vi.mock('@/components/navigation/connectionStatus/useConnectionHealth', () => ({
    useConnectionHealth: () => ({ status: 'online' }),
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    getServerInfo: () => ({ isCustom: false, hostname: 'example', port: null }),
}));

vi.mock('expo-image', () => ({
    Image: (props: any) => React.createElement('Image', props),
}));

vi.mock('@/components/navigation/Header', () => ({
    Header: (props: any) => React.createElement(
        'Header',
        props,
        props.headerLeft ? props.headerLeft() : null,
        props.headerRight ? props.headerRight() : null,
        props.title ?? null,
    ),
}));

describe('HomeHeader (native E2E testID accessibility)', () => {
    afterEach(standardCleanup);

    it('maps home-header-start-new-session testID into accessibilityLabel when native E2E labels are enabled', async () => {
        const previous = process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS;
        process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS = '1';
        try {
            const { HomeHeader } = await import('./HomeHeader');
            const screen = await renderScreen(<HomeHeader />);
            const button = screen.findByProps({ testID: 'home-header-start-new-session' });
            expect(button).toBeTruthy();
            expect(button.props.accessibilityLabel).toBe('home-header-start-new-session');
        } finally {
            if (previous === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS;
            else process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS = previous;
        }
    });
});
