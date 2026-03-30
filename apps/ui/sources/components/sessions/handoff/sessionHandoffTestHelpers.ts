import * as React from 'react';
import { vi } from 'vitest';

type SessionHandoffModuleFactory = () => unknown | Promise<unknown>;
type SessionHandoffImportOriginal = <T = unknown>() => Promise<T>;
type SessionHandoffStorageModuleFactory = (
    importOriginal: SessionHandoffImportOriginal,
) => unknown | Promise<unknown>;

type InstallSessionHandoffCommonModuleMocksOptions = Readonly<{
    icons?: SessionHandoffModuleFactory;
    modal?: SessionHandoffModuleFactory;
    reactNative?: SessionHandoffModuleFactory;
    storage?: SessionHandoffStorageModuleFactory;
    text?: SessionHandoffModuleFactory;
    typography?: SessionHandoffModuleFactory;
    unistyles?: SessionHandoffModuleFactory;
}>;

const sessionHandoffModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as SessionHandoffModuleFactory | undefined,
        modal: undefined as SessionHandoffModuleFactory | undefined,
        reactNative: undefined as SessionHandoffModuleFactory | undefined,
        storage: undefined as SessionHandoffStorageModuleFactory | undefined,
        text: undefined as SessionHandoffModuleFactory | undefined,
        typography: undefined as SessionHandoffModuleFactory | undefined,
        unistyles: undefined as SessionHandoffModuleFactory | undefined,
    },
}));

export function installSessionHandoffCommonModuleMocks(
    options: InstallSessionHandoffCommonModuleMocksOptions = {},
) {
    sessionHandoffModuleState.options = {
        icons: options.icons,
        modal: options.modal,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        typography: options.typography,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionHandoffModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sessionHandoffModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = sessionHandoffModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sessionHandoffModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/constants/Typography', async () => {
        const activeOptions = sessionHandoffModuleState.options;
        if (activeOptions.typography) {
            return await activeOptions.typography();
        }

        return {
            Typography: {
                default: () => ({}),
                mono: () => ({}),
            },
        };
    });

    vi.mock('@/text', async () => {
        const activeOptions = sessionHandoffModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/components/ui/text/Text', () => ({
        Text: (props: React.PropsWithChildren<Record<string, unknown>>) =>
            React.createElement('Text', props, props.children),
        TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
    }));

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = sessionHandoffModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
