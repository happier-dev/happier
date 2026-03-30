import * as React from 'react';
import { vi } from 'vitest';

type SessionSubagentModuleFactory = () => unknown | Promise<unknown>;

type InstallSessionSubagentCommonModuleMocksOptions = Readonly<{
    icons?: SessionSubagentModuleFactory;
    modal?: SessionSubagentModuleFactory;
    reactNative?: SessionSubagentModuleFactory;
    storage?: SessionSubagentModuleFactory;
    text?: SessionSubagentModuleFactory;
    unistyles?: SessionSubagentModuleFactory;
}>;

const sessionSubagentModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as SessionSubagentModuleFactory | undefined,
        modal: undefined as SessionSubagentModuleFactory | undefined,
        reactNative: undefined as SessionSubagentModuleFactory | undefined,
        storage: undefined as SessionSubagentModuleFactory | undefined,
        text: undefined as SessionSubagentModuleFactory | undefined,
        unistyles: undefined as SessionSubagentModuleFactory | undefined,
    },
}));

export function installSessionSubagentCommonModuleMocks(
    options: InstallSessionSubagentCommonModuleMocksOptions = {},
) {
    sessionSubagentModuleState.options = {
        icons: options.icons,
        modal: options.modal,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionSubagentModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sessionSubagentModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = sessionSubagentModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/components/ui/text/Text', () => ({
        Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
            React.createElement('Text', props, children),
    }));

    vi.mock('@/text', async () => {
        const activeOptions = sessionSubagentModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sessionSubagentModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async () => {
        const activeOptions = sessionSubagentModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage();
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
