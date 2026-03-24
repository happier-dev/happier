import { vi } from 'vitest';

type ValueRefsModuleFactory = () => unknown | Promise<unknown>;
type ValueRefsImportOriginal = <T = unknown>() => Promise<T>;
type ValueRefsStorageModuleFactory = (
    importOriginal: ValueRefsImportOriginal,
) => unknown | Promise<unknown>;

type InstallValueRefsCommonModuleMocksOptions = Readonly<{
    icons?: ValueRefsModuleFactory;
    modal?: ValueRefsModuleFactory;
    reactNative?: ValueRefsModuleFactory;
    storage?: ValueRefsStorageModuleFactory;
    text?: ValueRefsModuleFactory;
    unistyles?: ValueRefsModuleFactory;
}>;

const valueRefsModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as ValueRefsModuleFactory | undefined,
        modal: undefined as ValueRefsModuleFactory | undefined,
        reactNative: undefined as ValueRefsModuleFactory | undefined,
        storage: undefined as ValueRefsStorageModuleFactory | undefined,
        text: undefined as ValueRefsModuleFactory | undefined,
        unistyles: undefined as ValueRefsModuleFactory | undefined,
    },
}));

export function installValueRefsCommonModuleMocks(
    options: InstallValueRefsCommonModuleMocksOptions = {},
) {
    valueRefsModuleState.options = {
        icons: options.icons,
        modal: options.modal,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = valueRefsModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = valueRefsModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = valueRefsModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = valueRefsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = valueRefsModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = valueRefsModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
