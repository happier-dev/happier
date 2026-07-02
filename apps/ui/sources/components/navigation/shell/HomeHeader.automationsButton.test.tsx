import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());

const automationsSupportState = vi.hoisted(() => ({
    enabled: true,
}));

installNavigationShellCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key) => (key === 'automations.openA11y' ? 'Open automations' : key),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            router: { push: routerPushSpy },
            segments: [],
        });
        return expoRouterMock.module;
    },
    storage: async (importOriginal) => {
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
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

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

vi.mock('@/components/ui/feedback/AppUpdateStatusTag', () => ({
    AppUpdateStatusTag: (props: Record<string, unknown>) => React.createElement('AppUpdateStatusTag', props),
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: automationsSupportState.enabled }),
}));

function findPressableByLabel(tree: renderer.ReactTestRenderer, label: string) {
    return tree.findByProps({ accessibilityLabel: label });
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

    it('uses a compact update tag in the mobile logo slot', async () => {
        const { HomeHeader } = await import('./HomeHeader');

        const screen = await renderScreen(<HomeHeader />);
        const updateTag = screen.tree.findByType('AppUpdateStatusTag' as never);

        expect(updateTag.props.labelVariant).toBe('short');
        expect(updateTag.props.fallback).toBeTruthy();
    });
});
