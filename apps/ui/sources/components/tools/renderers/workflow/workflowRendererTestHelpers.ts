import * as React from 'react';
import { vi } from 'vitest';

type WorkflowRendererModuleFactory = () => unknown | Promise<unknown>;
type WorkflowRendererImportOriginal = <T = unknown>() => Promise<T>;
type WorkflowRendererStorageModuleFactory = (
    importOriginal: WorkflowRendererImportOriginal,
) => unknown | Promise<unknown>;

type InstallWorkflowRendererCommonModuleMocksOptions = Readonly<{
    modal?: WorkflowRendererModuleFactory;
    reactNative?: WorkflowRendererModuleFactory;
    router?: WorkflowRendererModuleFactory;
    storage?: WorkflowRendererStorageModuleFactory;
    text?: WorkflowRendererModuleFactory;
    unistyles?: WorkflowRendererModuleFactory;
}>;

const workflowRendererModuleState = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    options: {
        modal: undefined as WorkflowRendererModuleFactory | undefined,
        reactNative: undefined as WorkflowRendererModuleFactory | undefined,
        router: undefined as WorkflowRendererModuleFactory | undefined,
        storage: undefined as WorkflowRendererStorageModuleFactory | undefined,
        text: undefined as WorkflowRendererModuleFactory | undefined,
        unistyles: undefined as WorkflowRendererModuleFactory | undefined,
    },
}));

export function resetWorkflowRendererCommonModuleMockState() {
    workflowRendererModuleState.routerPushSpy.mockClear();
}

export function installWorkflowRendererCommonModuleMocks(
    options: InstallWorkflowRendererCommonModuleMocksOptions = {},
) {
    workflowRendererModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = workflowRendererModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = workflowRendererModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = workflowRendererModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = workflowRendererModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = workflowRendererModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: {
                push: workflowRendererModuleState.routerPushSpy,
            },
        });
        return routerMock.module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = workflowRendererModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });

    vi.mock('@expo/vector-icons', () => ({
        Ionicons: 'Ionicons',
    }));

    vi.mock('@/components/ui/text/Text', () => ({
        Text: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('Text', props, children),
        TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
    }));

    vi.mock('../../shell/presentation/ToolSectionView', () => ({
        ToolSectionView: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    }));
}

export { workflowRendererModuleState };
