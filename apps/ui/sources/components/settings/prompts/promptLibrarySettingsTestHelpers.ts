import { vi } from 'vitest';

type PromptLibrarySettingsModuleFactory = () => unknown | Promise<unknown>;
type PromptLibrarySettingsImportOriginal = <T = unknown>() => Promise<T>;
type PromptLibrarySettingsStorageModuleFactory = (
    importOriginal: PromptLibrarySettingsImportOriginal,
) => unknown | Promise<unknown>;

type InstallPromptLibrarySettingsCommonModuleMocksOptions = Readonly<{
    modal?: PromptLibrarySettingsModuleFactory;
    reactNative?: PromptLibrarySettingsModuleFactory;
    router?: PromptLibrarySettingsModuleFactory;
    storage?: PromptLibrarySettingsStorageModuleFactory;
    text?: PromptLibrarySettingsModuleFactory;
    unistyles?: PromptLibrarySettingsModuleFactory;
}>;

const promptLibrarySettingsModuleState = vi.hoisted(() => ({
    routerBackSpy: vi.fn(),
    routerPushSpy: vi.fn(),
    routerReplaceSpy: vi.fn(),
    options: {
        modal: undefined as PromptLibrarySettingsModuleFactory | undefined,
        reactNative: undefined as PromptLibrarySettingsModuleFactory | undefined,
        router: undefined as PromptLibrarySettingsModuleFactory | undefined,
        storage: undefined as PromptLibrarySettingsStorageModuleFactory | undefined,
        text: undefined as PromptLibrarySettingsModuleFactory | undefined,
        unistyles: undefined as PromptLibrarySettingsModuleFactory | undefined,
    },
}));

export const promptLibrarySettingsRouterBackSpy = promptLibrarySettingsModuleState.routerBackSpy;
export const promptLibrarySettingsRouterPushSpy = promptLibrarySettingsModuleState.routerPushSpy;
export const promptLibrarySettingsRouterReplaceSpy = promptLibrarySettingsModuleState.routerReplaceSpy;

export function resetPromptLibrarySettingsCommonModuleMockState() {
    promptLibrarySettingsModuleState.routerBackSpy.mockReset();
    promptLibrarySettingsModuleState.routerPushSpy.mockReset();
    promptLibrarySettingsModuleState.routerReplaceSpy.mockReset();
    promptLibrarySettingsModuleState.options = {
        modal: undefined,
        reactNative: undefined,
        router: undefined,
        storage: undefined,
        text: undefined,
        unistyles: undefined,
    };
}

export function installPromptLibrarySettingsCommonModuleMocks(
    options: InstallPromptLibrarySettingsCommonModuleMocksOptions = {},
) {
    promptLibrarySettingsModuleState.options = {
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
        const activeOptions = promptLibrarySettingsModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = promptLibrarySettingsModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                back: promptLibrarySettingsModuleState.routerBackSpy,
                push: promptLibrarySettingsModuleState.routerPushSpy,
                replace: promptLibrarySettingsModuleState.routerReplaceSpy,
            },
        }).module;
    });

    vi.mock('@/text', async () => {
        const activeOptions = promptLibrarySettingsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = promptLibrarySettingsModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = promptLibrarySettingsModuleState.options;
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
