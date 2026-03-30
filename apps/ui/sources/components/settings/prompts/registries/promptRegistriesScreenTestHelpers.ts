import { vi } from 'vitest';

type PromptRegistriesModuleFactory = () => unknown | Promise<unknown>;
type PromptRegistriesImportOriginal = <T = unknown>() => Promise<T>;
type PromptRegistriesStorageModuleFactory = (
    importOriginal: PromptRegistriesImportOriginal,
) => unknown | Promise<unknown>;

type InstallPromptRegistriesCommonModuleMocksOptions = Readonly<{
    modal?: PromptRegistriesModuleFactory;
    reactNative?: PromptRegistriesModuleFactory;
    router?: PromptRegistriesModuleFactory;
    storage?: PromptRegistriesStorageModuleFactory;
    text?: PromptRegistriesModuleFactory;
    unistyles?: PromptRegistriesModuleFactory;
}>;

const promptRegistriesModuleState = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    options: {
        modal: undefined as PromptRegistriesModuleFactory | undefined,
        reactNative: undefined as PromptRegistriesModuleFactory | undefined,
        router: undefined as PromptRegistriesModuleFactory | undefined,
        storage: undefined as PromptRegistriesStorageModuleFactory | undefined,
        text: undefined as PromptRegistriesModuleFactory | undefined,
        unistyles: undefined as PromptRegistriesModuleFactory | undefined,
    },
}));

export const promptRegistriesRouterPushSpy = promptRegistriesModuleState.routerPushSpy;

export function resetPromptRegistriesCommonModuleMockState() {
    promptRegistriesModuleState.routerPushSpy.mockReset();
    promptRegistriesModuleState.options = {
        modal: undefined,
        reactNative: undefined,
        router: undefined,
        storage: undefined,
        text: undefined,
        unistyles: undefined,
    };
}

export function installPromptRegistriesCommonModuleMocks(
    options: InstallPromptRegistriesCommonModuleMocksOptions = {},
) {
    promptRegistriesModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = promptRegistriesModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
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
        });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = promptRegistriesModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = promptRegistriesModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: promptRegistriesModuleState.routerPushSpy,
            },
        }).module;
    });

    vi.mock('@/text', async () => {
        const activeOptions = promptRegistriesModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = promptRegistriesModuleState.options;
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
        const activeOptions = promptRegistriesModuleState.options;
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
