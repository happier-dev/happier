import * as React from 'react';
import { vi } from 'vitest';

type SessionExecutionRunDetailsModuleFactory = () => unknown | Promise<unknown>;

type InstallSessionExecutionRunDetailsCommonModuleMocksOptions = Readonly<{
    modal?: SessionExecutionRunDetailsModuleFactory;
    reactNative?: SessionExecutionRunDetailsModuleFactory;
    router?: SessionExecutionRunDetailsModuleFactory;
    storage?: SessionExecutionRunDetailsModuleFactory;
    text?: SessionExecutionRunDetailsModuleFactory;
    unistyles?: SessionExecutionRunDetailsModuleFactory;
}>;

const sessionExecutionRunDetailsModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as SessionExecutionRunDetailsModuleFactory | undefined,
        reactNative: undefined as SessionExecutionRunDetailsModuleFactory | undefined,
        router: undefined as SessionExecutionRunDetailsModuleFactory | undefined,
        storage: undefined as SessionExecutionRunDetailsModuleFactory | undefined,
        text: undefined as SessionExecutionRunDetailsModuleFactory | undefined,
        unistyles: undefined as SessionExecutionRunDetailsModuleFactory | undefined,
    },
}));

export function installSessionExecutionRunDetailsCommonModuleMocks(
    options: InstallSessionExecutionRunDetailsCommonModuleMocksOptions = {},
) {
    sessionExecutionRunDetailsModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionExecutionRunDetailsModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (values: any) => values?.web ?? values?.default,
            },
            AppState: {
                currentState: 'active',
                addEventListener: () => ({ remove: () => {} }),
            },
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            ActivityIndicator: 'ActivityIndicator',
            TextInput: (props: any) => React.createElement('TextInput', props),
        });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sessionExecutionRunDetailsModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = sessionExecutionRunDetailsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sessionExecutionRunDetailsModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = sessionExecutionRunDetailsModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: vi.fn(), back: vi.fn() },
        }).module;
    });

    vi.mock('@/sync/domains/state/storage', async () => {
        const activeOptions = sessionExecutionRunDetailsModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage();
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => ({ sessions: { s1: { metadata: { machineId: 'm1' } } } }),
            },
            useSession: () => ({
                id: 's1',
                metadata: { flavor: 'codex' },
                accessLevel: 'edit',
                canApprovePermissions: true,
            }),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useResolvedSessionMessageRouteId: () => null,
            useMessage: () => null,
        });
    });
}
