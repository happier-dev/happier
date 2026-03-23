import * as React from 'react';
import { vi } from 'vitest';

type SessionActionsModuleFactory = () => unknown | Promise<unknown>;
type SessionActionsImportOriginal = <T = unknown>() => Promise<T>;
type SessionActionsStorageModuleFactory = (
    importOriginal: SessionActionsImportOriginal,
) => unknown | Promise<unknown>;

type InstallSessionActionsCommonModuleMocksOptions = Readonly<{
    modal?: SessionActionsModuleFactory;
    reactNative?: SessionActionsModuleFactory;
    router?: SessionActionsModuleFactory;
    storage?: SessionActionsStorageModuleFactory;
    text?: SessionActionsModuleFactory;
    unistyles?: SessionActionsModuleFactory;
}>;

const sessionActionsModuleState = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    options: {
        modal: undefined as SessionActionsModuleFactory | undefined,
        reactNative: undefined as SessionActionsModuleFactory | undefined,
        router: undefined as SessionActionsModuleFactory | undefined,
        storage: undefined as SessionActionsStorageModuleFactory | undefined,
        text: undefined as SessionActionsModuleFactory | undefined,
        unistyles: undefined as SessionActionsModuleFactory | undefined,
    },
}));

export function resetSessionActionsCommonModuleMockState() {
    sessionActionsModuleState.routerPushSpy.mockClear();
}

export function installSessionActionsCommonModuleMocks(
    options: InstallSessionActionsCommonModuleMocksOptions = {},
) {
    sessionActionsModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionActionsModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@expo/vector-icons', () => ({
        Ionicons: 'Ionicons',
    }));

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sessionActionsModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = sessionActionsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sessionActionsModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = sessionActionsModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: {
                push: sessionActionsModuleState.routerPushSpy,
            },
        });
        return routerMock.module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = sessionActionsModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });

    vi.mock('@/components/ui/text/Text', () => ({
        Text: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('Text', props, children),
        TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
    }));
}

export { sessionActionsModuleState };
