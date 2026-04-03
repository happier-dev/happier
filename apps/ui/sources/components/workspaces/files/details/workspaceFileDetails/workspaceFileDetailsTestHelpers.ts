import { vi } from 'vitest';

type WorkspaceFileDetailsModuleFactory = () => unknown | Promise<unknown>;

type InstallWorkspaceFileDetailsCommonModuleMocksOptions = Readonly<{
    modal?: WorkspaceFileDetailsModuleFactory;
    reactNative?: WorkspaceFileDetailsModuleFactory;
    text?: WorkspaceFileDetailsModuleFactory;
}>;

const workspaceFileDetailsModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as WorkspaceFileDetailsModuleFactory | undefined,
        reactNative: undefined as WorkspaceFileDetailsModuleFactory | undefined,
        text: undefined as WorkspaceFileDetailsModuleFactory | undefined,
    },
}));

export function installWorkspaceFileDetailsCommonModuleMocks(
    options: InstallWorkspaceFileDetailsCommonModuleMocksOptions = {},
) {
    workspaceFileDetailsModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        text: options.text,
    };

    vi.mock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = workspaceFileDetailsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = workspaceFileDetailsModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });
}
