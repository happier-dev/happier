import { vi } from 'vitest';

type PromptTemplatesModuleFactory = () => unknown | Promise<unknown>;
type PromptTemplatesImportOriginal = <T = unknown>() => Promise<T>;
type PromptTemplatesStorageModuleFactory = (
    importOriginal: PromptTemplatesImportOriginal,
) => unknown | Promise<unknown>;

type InstallPromptTemplatesCommonModuleMocksOptions = Readonly<{
    modal?: PromptTemplatesModuleFactory;
    reactNative?: PromptTemplatesModuleFactory;
    router?: PromptTemplatesModuleFactory;
    storage?: PromptTemplatesStorageModuleFactory;
    text?: PromptTemplatesModuleFactory;
    unistyles?: PromptTemplatesModuleFactory;
}>;

const promptTemplatesModuleState = vi.hoisted(() => ({
    routerBackSpy: vi.fn(),
    routerPushSpy: vi.fn(),
    options: {
        modal: undefined as PromptTemplatesModuleFactory | undefined,
        reactNative: undefined as PromptTemplatesModuleFactory | undefined,
        router: undefined as PromptTemplatesModuleFactory | undefined,
        storage: undefined as PromptTemplatesStorageModuleFactory | undefined,
        text: undefined as PromptTemplatesModuleFactory | undefined,
        unistyles: undefined as PromptTemplatesModuleFactory | undefined,
    },
}));

export const promptTemplatesRouterBackSpy = promptTemplatesModuleState.routerBackSpy;
export const promptTemplatesRouterPushSpy = promptTemplatesModuleState.routerPushSpy;

export function resetPromptTemplatesCommonModuleMockState() {
    promptTemplatesModuleState.routerBackSpy.mockReset();
    promptTemplatesModuleState.routerPushSpy.mockReset();
    promptTemplatesModuleState.options = {
        modal: undefined,
        reactNative: undefined,
        router: undefined,
        storage: undefined,
        text: undefined,
        unistyles: undefined,
    };
}

export function installPromptTemplatesCommonModuleMocks(
    options: InstallPromptTemplatesCommonModuleMocksOptions = {},
) {
    promptTemplatesModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = promptTemplatesModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            ScrollView: 'ScrollView',
            View: 'View',
            Switch: 'Switch',
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
        const activeOptions = promptTemplatesModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = promptTemplatesModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                back: promptTemplatesModuleState.routerBackSpy,
                push: promptTemplatesModuleState.routerPushSpy,
            },
        }).module;
    });

    vi.mock('@/text', async () => {
        const activeOptions = promptTemplatesModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = promptTemplatesModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = promptTemplatesModuleState.options;
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
