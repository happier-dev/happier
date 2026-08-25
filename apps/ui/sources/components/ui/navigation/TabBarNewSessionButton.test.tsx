import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installNavigationCommonModuleMocks } from './navigationTestHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNavigationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, children),
            Pressable: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Pressable', props, children),
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

vi.mock('expo-blur', () => ({
    BlurView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('BlurView', props, children),
}));

describe('TabBarNewSessionButton', () => {
    afterEach(() => {
        standardCleanup();
        expoRouterMock.spies.push.mockReset();
    });

    it('opens an explicit ordinary-entry draft route when pressed', async () => {
        const { TabBarNewSessionButton } = await import('./TabBarNewSessionButton');

        const screen = await renderScreen(<TabBarNewSessionButton />);
        screen.pressByTestId('tabbar-start-new-session');

        expect(expoRouterMock.spies.push).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                draftOrigin: 'ordinary',
            },
        });
    });

    it('exposes the new-session action to assistive technology', async () => {
        const { TabBarNewSessionButton } = await import('./TabBarNewSessionButton');

        const screen = await renderScreen(<TabBarNewSessionButton />);
        const button = screen.findByTestId('tabbar-start-new-session');

        // An icon-only control with no label is unusable with a screen reader, and this one has no
        // adjacent text to borrow meaning from.
        expect(button?.props.accessibilityRole).toBe('button');
        expect(button?.props.accessibilityLabel).toBe('newSession.title');
    });
});
