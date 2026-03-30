import { vi } from 'vitest';

type PromptStacksModuleFactory = () => unknown | Promise<unknown>;
type PromptStacksImportOriginal = <T = unknown>() => Promise<T>;
type PromptStacksStorageModuleFactory = (
    importOriginal: PromptStacksImportOriginal,
) => unknown | Promise<unknown>;

type InstallPromptStacksCommonModuleMocksOptions = Readonly<{
    modal?: PromptStacksModuleFactory;
    reactNative?: PromptStacksModuleFactory;
    router?: PromptStacksModuleFactory;
    storage?: PromptStacksStorageModuleFactory;
    text?: PromptStacksModuleFactory;
    unistyles?: PromptStacksModuleFactory;
}>;

const promptStacksModuleState = vi.hoisted(() => ({
    routerBackSpy: vi.fn(),
    routerPushSpy: vi.fn(),
    options: {
        modal: undefined as PromptStacksModuleFactory | undefined,
        reactNative: undefined as PromptStacksModuleFactory | undefined,
        router: undefined as PromptStacksModuleFactory | undefined,
        storage: undefined as PromptStacksStorageModuleFactory | undefined,
        text: undefined as PromptStacksModuleFactory | undefined,
        unistyles: undefined as PromptStacksModuleFactory | undefined,
    },
}));

export const promptStacksRouterBackSpy = promptStacksModuleState.routerBackSpy;
export const promptStacksRouterPushSpy = promptStacksModuleState.routerPushSpy;

export function resetPromptStacksCommonModuleMockState() {
    promptStacksModuleState.routerBackSpy.mockReset();
    promptStacksModuleState.routerPushSpy.mockReset();
    promptStacksModuleState.options = {
        modal: undefined,
        reactNative: undefined,
        router: undefined,
        storage: undefined,
        text: undefined,
        unistyles: undefined,
    };
}

export function installPromptStacksCommonModuleMocks(
    options: InstallPromptStacksCommonModuleMocksOptions = {},
) {
    promptStacksModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = promptStacksModuleState.options;
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
        const activeOptions = promptStacksModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = promptStacksModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                back: promptStacksModuleState.routerBackSpy,
                push: promptStacksModuleState.routerPushSpy,
            },
        }).module;
    });

    vi.mock('@/text', async () => {
        const activeOptions = promptStacksModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = promptStacksModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = promptStacksModuleState.options;
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
