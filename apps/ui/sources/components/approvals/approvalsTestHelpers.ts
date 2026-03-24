import { vi } from 'vitest';

type ApprovalModuleFactory = () => unknown | Promise<unknown>;
type ApprovalImportOriginal = <T = unknown>() => Promise<T>;
type ApprovalStorageModuleFactory = (importOriginal: ApprovalImportOriginal) => unknown | Promise<unknown>;

type InstallApprovalCommonModuleMocksOptions = Readonly<{
    modal?: ApprovalModuleFactory;
    reactNative?: ApprovalModuleFactory;
    router?: ApprovalModuleFactory;
    storage?: ApprovalStorageModuleFactory;
    text?: ApprovalModuleFactory;
    unistyles?: ApprovalModuleFactory;
}>;

const approvalModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as ApprovalModuleFactory | undefined,
        reactNative: undefined as ApprovalModuleFactory | undefined,
        router: undefined as ApprovalModuleFactory | undefined,
        storage: undefined as ApprovalStorageModuleFactory | undefined,
        text: undefined as ApprovalModuleFactory | undefined,
        unistyles: undefined as ApprovalModuleFactory | undefined,
    },
}));

export function installApprovalCommonModuleMocks(
    options: InstallApprovalCommonModuleMocksOptions = {},
) {
    approvalModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = approvalModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = approvalModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = approvalModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/text', async () => {
        const activeOptions = approvalModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = approvalModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = approvalModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
