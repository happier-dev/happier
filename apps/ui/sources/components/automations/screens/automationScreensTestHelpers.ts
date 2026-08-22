import { vi } from 'vitest';

import type { TextModuleMockOptions } from '@/dev/testkit/mocks/text';

type AutomationScreensModuleFactory = () => unknown | Promise<unknown>;
type AutomationScreensImportOriginal = <T = unknown>() => Promise<T>;
type AutomationScreensStorageModuleFactory = (
    importOriginal: AutomationScreensImportOriginal,
) => unknown | Promise<unknown>;

type InstallAutomationScreensCommonModuleMocksOptions = Readonly<{
    modal?: AutomationScreensModuleFactory;
    router?: AutomationScreensModuleFactory;
    storage?: AutomationScreensStorageModuleFactory;
    /**
     * Translation behavior, resolved on every `t(...)` call rather than when the
     * `@/text` mock module is built. Vitest hoists the `vi.mock(...)` calls below
     * out of this function, so a mocked module whose first import happens while the
     * test file's own static imports evaluate is built BEFORE the body of that file
     * runs `installAutomationScreensCommonModuleMocks(...)`. A factory-time read
     * therefore silently produced the default identity translator and rendered raw
     * translation keys; these options stay live instead.
     */
    text?: TextModuleMockOptions;
    unistyles?: AutomationScreensModuleFactory;
}>;

const automationScreensModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as AutomationScreensModuleFactory | undefined,
        router: undefined as AutomationScreensModuleFactory | undefined,
        storage: undefined as AutomationScreensStorageModuleFactory | undefined,
        text: undefined as TextModuleMockOptions | undefined,
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
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        const defaultTextOptions: TextModuleMockOptions = { translate: (key: string) => key };
        const textRuntime = () => createTextModuleMock(
            automationScreensModuleState.options.text ?? defaultTextOptions,
        );

        return {
            t: (...args: Parameters<ReturnType<typeof createTextModuleMock>['t']>) => textRuntime().t(...args),
            tLoose: (...args: Parameters<ReturnType<typeof createTextModuleMock>['tLoose']>) => textRuntime().tLoose(...args),
            getPreferredLanguage: () => textRuntime().getPreferredLanguage(),
            hasTranslation: (key: string) => textRuntime().hasTranslation(key),
        };
    });
}
