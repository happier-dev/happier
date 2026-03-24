import * as React from 'react';
import { vi } from 'vitest';

type NavigationModuleFactory = () => unknown | Promise<unknown>;
type NavigationImportOriginal = <T = unknown>() => Promise<T>;
type NavigationStorageModuleFactory = (
    importOriginal: NavigationImportOriginal,
) => unknown | Promise<unknown>;

type InstallNavigationCommonModuleMocksOptions = Readonly<{
    reactNative?: NavigationModuleFactory;
    storage?: NavigationStorageModuleFactory;
    text?: NavigationModuleFactory;
    typography?: NavigationModuleFactory;
    uiText?: NavigationModuleFactory;
    unistyles?: NavigationModuleFactory;
}>;

const navigationModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as NavigationModuleFactory | undefined,
        storage: undefined as NavigationStorageModuleFactory | undefined,
        text: undefined as NavigationModuleFactory | undefined,
        typography: undefined as NavigationModuleFactory | undefined,
        uiText: undefined as NavigationModuleFactory | undefined,
        unistyles: undefined as NavigationModuleFactory | undefined,
    },
}));

export function installNavigationCommonModuleMocks(
    options: InstallNavigationCommonModuleMocksOptions = {},
) {
    navigationModuleState.options = {
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        typography: options.typography,
        uiText: options.uiText,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = navigationModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = navigationModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = navigationModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = navigationModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });

    vi.mock('@/components/ui/text/Text', async () => {
        const activeOptions = navigationModuleState.options;
        if (activeOptions.uiText) {
            return await activeOptions.uiText();
        }

        return {
            Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
        };
    });

    vi.mock('@/constants/Typography', async () => {
        const activeOptions = navigationModuleState.options;
        if (activeOptions.typography) {
            return await activeOptions.typography();
        }

        return {
            Typography: { default: () => ({}) },
        };
    });
}
