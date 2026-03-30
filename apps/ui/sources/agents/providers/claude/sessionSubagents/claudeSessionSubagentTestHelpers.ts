import * as React from 'react';
import { vi } from 'vitest';

type ClaudeSessionSubagentModuleFactory = () => unknown | Promise<unknown>;

type InstallClaudeSessionSubagentCommonModuleMocksOptions = Readonly<{
    reactNative?: ClaudeSessionSubagentModuleFactory;
    text?: ClaudeSessionSubagentModuleFactory;
    unistyles?: ClaudeSessionSubagentModuleFactory;
}>;

const claudeSessionSubagentModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as ClaudeSessionSubagentModuleFactory | undefined,
        text: undefined as ClaudeSessionSubagentModuleFactory | undefined,
        unistyles: undefined as ClaudeSessionSubagentModuleFactory | undefined,
    },
}));

export function installClaudeSessionSubagentCommonModuleMocks(
    options: InstallClaudeSessionSubagentCommonModuleMocksOptions = {},
): void {
    claudeSessionSubagentModuleState.options = {
        reactNative: options.reactNative,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = claudeSessionSubagentModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = claudeSessionSubagentModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = claudeSessionSubagentModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });
}
