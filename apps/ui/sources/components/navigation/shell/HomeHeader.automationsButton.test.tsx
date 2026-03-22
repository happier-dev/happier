import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());

const automationsSupportState = vi.hoisted(() => ({
    enabled: true,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            Platform: {
                                OS: 'ios',
                            },
                            View: 'View',
                            Text: 'Text',
                            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                        }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { push: routerPushSpy },
        segments: [],
    });
    return expoRouterMock.module;
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/navigation/Header', () => ({
    Header: ({ headerLeft, headerRight, title }: any) =>
        React.createElement(
            'Header',
            null,
            headerLeft ? headerLeft() : null,
            title ?? null,
            headerRight ? headerRight() : null,
        ),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSocketStatus: () => ({
                status: 'connected',
                lastConnectedAt: null,
                lastDisconnectedAt: null,
                lastError: null,
                lastErrorAt: null,
            }),
            useSyncError: () => null,
        },
    });
});

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: automationsSupportState.enabled }),
}));

function findPressableByLabel(tree: renderer.ReactTestRenderer, label: string) {
    return tree.find((node) => (node.type as unknown) === 'Pressable' && node.props.accessibilityLabel === label);
}

describe('HomeHeader automations button', () => {
    beforeEach(() => {
        routerPushSpy.mockReset();
        automationsSupportState.enabled = true;
    });

    it('shows automations button next to logo and navigates to automations', async () => {
        const { HomeHeader } = await import('./HomeHeader');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<HomeHeader />)).tree;

        const button = findPressableByLabel(tree!, 'Open automations');
        await act(async () => {
            await pressTestInstanceAsync(button);
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/automations');
    });

    it('hides automations button when server reports automations disabled', async () => {
        automationsSupportState.enabled = false;
        const { HomeHeader } = await import('./HomeHeader');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<HomeHeader />)).tree;

        expect(() => findPressableByLabel(tree!, 'Open automations')).toThrow();
    });
});
