import { vi } from 'vitest';

type AgentInputModuleFactory = () => unknown | Promise<unknown>;
type AgentInputImportOriginal = <T = unknown>() => Promise<T>;
type AgentInputStorageModuleFactory = (importOriginal: AgentInputImportOriginal) => unknown | Promise<unknown>;

type InstallAgentInputCommonModuleMocksOptions = Readonly<{
    icons?: AgentInputModuleFactory;
    modal?: AgentInputModuleFactory;
    reactNative?: AgentInputModuleFactory;
    storage?: AgentInputStorageModuleFactory;
    text?: AgentInputModuleFactory;
    unistyles?: AgentInputModuleFactory;
}>;

const agentInputCommonModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as AgentInputModuleFactory | undefined,
        modal: undefined as AgentInputModuleFactory | undefined,
        reactNative: undefined as AgentInputModuleFactory | undefined,
        storage: undefined as AgentInputStorageModuleFactory | undefined,
        text: undefined as AgentInputModuleFactory | undefined,
        unistyles: undefined as AgentInputModuleFactory | undefined,
    },
}));

export function installAgentInputCommonModuleMocks(
    options: InstallAgentInputCommonModuleMocksOptions = {},
) {
    agentInputCommonModuleState.options = {
        icons: options.icons,
        modal: options.modal,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = agentInputCommonModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = agentInputCommonModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = agentInputCommonModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = agentInputCommonModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = agentInputCommonModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = agentInputCommonModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const [{ createStorageModuleStub, createUseSettingMock }, { settingsDefaults }] = await Promise.all([
            import('@/dev/testkit/mocks/storage'),
            import('@/sync/domains/settings/settings'),
        ]);

        return createStorageModuleStub({
            useSettings: () => settingsDefaults,
            useSetting: createUseSettingMock({
                fallback: (key) => settingsDefaults[key],
            }),
        });
    });
}
