import * as React from 'react';
import { vi } from 'vitest';

type SessionExecutionRunListModuleFactory = () => unknown | Promise<unknown>;

type InstallSessionExecutionRunListCommonModuleMocksOptions = Readonly<{
    reactNative?: SessionExecutionRunListModuleFactory;
    text?: SessionExecutionRunListModuleFactory;
    unistyles?: SessionExecutionRunListModuleFactory;
}>;

const sessionExecutionRunListModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as SessionExecutionRunListModuleFactory | undefined,
        text: undefined as SessionExecutionRunListModuleFactory | undefined,
        unistyles: undefined as SessionExecutionRunListModuleFactory | undefined,
    },
}));

vi.mock('react-native', async () => {
    const activeOptions = sessionExecutionRunListModuleState.options;
    if (activeOptions.reactNative) {
        return await activeOptions.reactNative();
    }

    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, children),
        Text: 'Text',
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown> | undefined) =>
                options?.web ?? options?.default ?? options?.ios ?? null,
        },
        AppState: {
            addEventListener: () => ({ remove: () => {} }),
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const activeOptions = sessionExecutionRunListModuleState.options;
    if (activeOptions.unistyles) {
        return await activeOptions.unistyles();
    }

    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const activeOptions = sessionExecutionRunListModuleState.options;
    if (activeOptions.text) {
        return await activeOptions.text();
    }

    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

export function installSessionExecutionRunListCommonModuleMocks(
    options: InstallSessionExecutionRunListCommonModuleMocksOptions = {},
): void {
    sessionExecutionRunListModuleState.options = {
        reactNative: options.reactNative,
        text: options.text,
        unistyles: options.unistyles,
    };
}
