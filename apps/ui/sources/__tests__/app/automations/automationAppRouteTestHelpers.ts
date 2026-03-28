import { vi } from 'vitest';

type AutomationAppRouteModuleFactory = () => unknown | Promise<unknown>;

type InstallAutomationAppRouteCommonModuleMocksOptions = Readonly<{
    modal?: AutomationAppRouteModuleFactory;
    router?: AutomationAppRouteModuleFactory;
    storage?: AutomationAppRouteModuleFactory;
    text?: AutomationAppRouteModuleFactory;
    unistyles?: AutomationAppRouteModuleFactory;
}>;

const automationAppRouteModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as AutomationAppRouteModuleFactory | undefined,
        router: undefined as AutomationAppRouteModuleFactory | undefined,
        storage: undefined as AutomationAppRouteModuleFactory | undefined,
        text: undefined as AutomationAppRouteModuleFactory | undefined,
        unistyles: undefined as AutomationAppRouteModuleFactory | undefined,
    },
}));

export function installAutomationAppRouteCommonModuleMocks(
    options: InstallAutomationAppRouteCommonModuleMocksOptions = {},
) {
    automationAppRouteModuleState.options = {
        modal: options.modal,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('expo-router', async () => {
        const activeOptions = automationAppRouteModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = automationAppRouteModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = automationAppRouteModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage();
        }

        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {},
        });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = automationAppRouteModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/text', async () => {
        const activeOptions = automationAppRouteModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });
}
