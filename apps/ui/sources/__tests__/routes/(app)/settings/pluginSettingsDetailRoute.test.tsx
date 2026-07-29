import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pluginDetailScreenSpy = vi.fn((props: { pluginId: string | null }) => React.createElement('PluginDetailScreen', props));
const localSearchParamsState = {
    pluginId: 'installed-plugin' as string | string[] | undefined,
};


vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        params: () => ({ pluginId: localSearchParamsState.pluginId }),
    });
    return {
        ...routerMock.module,
        useLocalSearchParams: () => ({ pluginId: localSearchParamsState.pluginId }),
    };
});

vi.mock('@/components/settings/plugins/detail/PluginDetailScreen', () => ({
    PluginDetailScreen: (props: { pluginId: string | null }) => pluginDetailScreenSpy(props),
}));

afterEach(() => {
    pluginDetailScreenSpy.mockClear();
    localSearchParamsState.pluginId = 'installed-plugin';
    standardCleanup();
});

describe('PluginDetailRoute', () => {
    it('passes the parsed plugin id to the detail screen', async () => {
        const { default: PluginDetailRoute } = await import('@/app/(app)/settings/plugins/[pluginId]');
        const screen = await renderScreen(<PluginDetailRoute />);

        expect(pluginDetailScreenSpy).toHaveBeenCalledWith({ pluginId: 'installed-plugin' });
        expect(screen.findByType('PluginDetailScreen' as any)?.props.pluginId).toBe('installed-plugin');
    });

    it('passes null when the route param is missing or empty', async () => {
        localSearchParamsState.pluginId = [''];

        const { default: PluginDetailRoute } = await import('@/app/(app)/settings/plugins/[pluginId]');
        const screen = await renderScreen(<PluginDetailRoute />);

        expect(pluginDetailScreenSpy).toHaveBeenCalledWith({ pluginId: null });
        expect(screen.findByType('PluginDetailScreen' as any)?.props.pluginId).toBeNull();
    });
});
