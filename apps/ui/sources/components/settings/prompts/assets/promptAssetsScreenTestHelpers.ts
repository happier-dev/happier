import { vi } from 'vitest';

type PromptAssetsModuleFactory = () => unknown | Promise<unknown>;
type PromptAssetsImportOriginal = <T = unknown>() => Promise<T>;
type PromptAssetsStorageModuleFactory = (
    importOriginal: PromptAssetsImportOriginal,
) => unknown | Promise<unknown>;

type InstallPromptAssetsCommonModuleMocksOptions = Readonly<{
    modal?: PromptAssetsModuleFactory;
    reactNative?: PromptAssetsModuleFactory;
    router?: PromptAssetsModuleFactory;
    storage?: PromptAssetsStorageModuleFactory;
    text?: PromptAssetsModuleFactory;
    unistyles?: PromptAssetsModuleFactory;
}>;

const promptAssetsModuleState = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    options: {
        modal: undefined as PromptAssetsModuleFactory | undefined,
        reactNative: undefined as PromptAssetsModuleFactory | undefined,
        router: undefined as PromptAssetsModuleFactory | undefined,
        storage: undefined as PromptAssetsStorageModuleFactory | undefined,
        text: undefined as PromptAssetsModuleFactory | undefined,
        unistyles: undefined as PromptAssetsModuleFactory | undefined,
    },
}));

export const promptAssetsRouterPushSpy = promptAssetsModuleState.routerPushSpy;

export function resetPromptAssetsCommonModuleMockState() {
    promptAssetsModuleState.routerPushSpy.mockReset();
    promptAssetsModuleState.options = {
        modal: undefined,
        reactNative: undefined,
        router: undefined,
        storage: undefined,
        text: undefined,
        unistyles: undefined,
    };
}

export function installPromptAssetsCommonModuleMocks(
    options: InstallPromptAssetsCommonModuleMocksOptions = {},
) {
    promptAssetsModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    ScrollView: 'ScrollView',
                    TextInput: 'TextInput',
                    Platform: {
                        OS: 'web',
                        select: ({
                            web,
                            default: defaultValue,
                        }: {
                            web?: unknown;
                            default?: unknown;
                        }) => web ?? defaultValue,
                    },
                }
    );
});

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = promptAssetsModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = promptAssetsModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: promptAssetsModuleState.routerPushSpy,
            },
        }).module;
    });

    vi.mock('@/text', async () => {
        const activeOptions = promptAssetsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = promptAssetsModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: vi.fn(async () => true),
            },
        }).module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = promptAssetsModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useArtifacts: () => [],
            useAllMachines: () => [],
            useMachineListByServerId: () => ({}),
            useMachineListStatusByServerId: () => ({}),
            useSettingMutable: () => [null, vi.fn()],
        });
    });
}
