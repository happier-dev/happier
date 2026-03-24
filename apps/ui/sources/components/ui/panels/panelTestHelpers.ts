import * as React from 'react';
import { vi } from 'vitest';

type PanelModuleFactory = () => unknown | Promise<unknown>;

type InstallPanelCommonModuleMocksOptions = Readonly<{
    reactNative?: PanelModuleFactory;
    text?: PanelModuleFactory;
    unistyles?: PanelModuleFactory;
}>;

const panelModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as PanelModuleFactory | undefined,
        text: undefined as PanelModuleFactory | undefined,
        unistyles: undefined as PanelModuleFactory | undefined,
    },
}));

export function installPanelCommonModuleMocks(
    options: InstallPanelCommonModuleMocksOptions = {},
): void {
    panelModuleState.options = {
        reactNative: options.reactNative,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = panelModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            PanResponder: {
                create: () => ({ panHandlers: {} }),
            },
            Platform: {
                OS: 'web',
                select: (value: any) => value?.default ?? null,
            },
        });
    });

    vi.mock('@/text', async () => {
        const activeOptions = panelModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = panelModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });
}
