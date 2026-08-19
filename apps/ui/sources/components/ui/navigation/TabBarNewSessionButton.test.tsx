import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installNavigationCommonModuleMocks } from './navigationTestHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNavigationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    },
    storage: async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
        return {
            ...actual,
            useSetting: ((key: string) => {
                if (key === 'tabBarShowLabels') return true;
                if (key === 'tabBarSize') return 'regular';
                return undefined;
            }) as typeof import('@/sync/domains/state/storage').useSetting,
        };
    },
});

const expoRouterMock = createExpoRouterMock();

vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('expo-blur', () => ({
    BlurView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('BlurView', props, children),
}));

describe('TabBarNewSessionButton', () => {
    afterEach(() => {
        standardCleanup();
        expoRouterMock.spies.push.mockReset();
    });

    it('opens the new-session flow when pressed', async () => {
        const { TabBarNewSessionButton } = await import('./TabBarNewSessionButton');

        const screen = await renderScreen(<TabBarNewSessionButton />);
        screen.pressByTestId('tabbar-start-new-session');

        expect(expoRouterMock.spies.push).toHaveBeenCalledWith('/new');
    });

    it('exposes the new-session action to assistive technology', async () => {
        const { TabBarNewSessionButton } = await import('./TabBarNewSessionButton');

        const screen = await renderScreen(<TabBarNewSessionButton />);
        const button = screen.findByTestId('tabbar-start-new-session');

        expect(button?.props.accessibilityRole).toBe('button');
        expect(button?.props.accessibilityLabel).toBe('newSession.title');
    });
});
