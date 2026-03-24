import * as React from 'react';
import { vi } from 'vitest';
import { createPassThroughComponent } from '@/dev/testkit/mocks/components';

type AutomationModuleFactory = () => unknown | Promise<unknown>;

type InstallAutomationComponentCommonModuleMocksOptions = Readonly<{
    reactNative?: AutomationModuleFactory;
    text?: AutomationModuleFactory;
    unistyles?: AutomationModuleFactory;
}>;

const automationModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as AutomationModuleFactory | undefined,
        text: undefined as AutomationModuleFactory | undefined,
        unistyles: undefined as AutomationModuleFactory | undefined,
    },
}));

export function installAutomationComponentCommonModuleMocks(
    options: InstallAutomationComponentCommonModuleMocksOptions = {},
): void {
    automationModuleState.options = {
        reactNative: options.reactNative,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = automationModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            ActivityIndicator: createPassThroughComponent('ActivityIndicator'),
            View: createPassThroughComponent('View'),
            Platform: {
                OS: 'web',
                select: <T,>(value: { web?: T; default?: T; ios?: T }) => value.web ?? value.default ?? value.ios,
            },
        });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = automationModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = automationModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });
}
