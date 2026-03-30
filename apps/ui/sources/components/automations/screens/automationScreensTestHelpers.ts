import { vi } from 'vitest';

type AutomationScreensModuleFactory = () => unknown | Promise<unknown>;
type AutomationScreensImportOriginal = <T = unknown>() => Promise<T>;
type AutomationScreensStorageModuleFactory = (
    importOriginal: AutomationScreensImportOriginal,
) => unknown | Promise<unknown>;

type InstallAutomationScreensCommonModuleMocksOptions = Readonly<{
    modal?: AutomationScreensModuleFactory;
    router?: AutomationScreensModuleFactory;
    storage?: AutomationScreensStorageModuleFactory;
    text?: AutomationScreensModuleFactory;
    unistyles?: AutomationScreensModuleFactory;
}>;

const automationScreensModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as AutomationScreensModuleFactory | undefined,
        router: undefined as AutomationScreensModuleFactory | undefined,
        storage: undefined as AutomationScreensStorageModuleFactory | undefined,
        text: undefined as AutomationScreensModuleFactory | undefined,
        unistyles: undefined as AutomationScreensModuleFactory | undefined,
    },
}));

export function installAutomationScreensCommonModuleMocks(
    options: InstallAutomationScreensCommonModuleMocksOptions = {},
) {
    automationScreensModuleState.options = {
        modal: options.modal,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = automationScreensModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = automationScreensModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/modal', async () => {
        const activeOptions = automationScreensModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = automationScreensModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });

    vi.mock('@/text', async () => {
        const activeOptions = automationScreensModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });
}
