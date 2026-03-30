import * as React from 'react';
import { vi } from 'vitest';

type SessionMessageCardModuleFactory = () => unknown | Promise<unknown>;
type SessionMessageCardImportOriginal = <T = unknown>() => Promise<T>;
type SessionMessageCardStorageModuleFactory = (
    importOriginal: SessionMessageCardImportOriginal,
) => unknown | Promise<unknown>;

type InstallSessionMessageCardCommonModuleMocksOptions = Readonly<{
    reactNative?: SessionMessageCardModuleFactory;
    storage?: SessionMessageCardStorageModuleFactory;
    text?: SessionMessageCardModuleFactory;
    uiText?: SessionMessageCardModuleFactory;
    unistyles?: SessionMessageCardModuleFactory;
}>;

const sessionMessageCardModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as SessionMessageCardModuleFactory | undefined,
        storage: undefined as SessionMessageCardStorageModuleFactory | undefined,
        text: undefined as SessionMessageCardModuleFactory | undefined,
        uiText: undefined as SessionMessageCardModuleFactory | undefined,
        unistyles: undefined as SessionMessageCardModuleFactory | undefined,
    },
}));

export function installSessionMessageCardCommonModuleMocks(
    options: InstallSessionMessageCardCommonModuleMocksOptions = {},
): void {
    sessionMessageCardModuleState.options = {
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        uiText: options.uiText,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionMessageCardModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sessionMessageCardModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = sessionMessageCardModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/components/ui/text/Text', async () => {
        const activeOptions = sessionMessageCardModuleState.options;
        if (activeOptions.uiText) {
            return await activeOptions.uiText();
        }

        return {
            Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Text', props, props.children),
        };
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = sessionMessageCardModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
