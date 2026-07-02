import { vi } from 'vitest';

type AgentInputModuleFactory = () => unknown | Promise<unknown>;
type AgentInputImportOriginal = <T = unknown>() => Promise<T>;
type AgentInputStorageModuleFactory = (importOriginal: AgentInputImportOriginal) => unknown | Promise<unknown>;
type AgentInputStorageStoreModuleFactory = AgentInputModuleFactory;

type InstallAgentInputCommonModuleMocksOptions = Readonly<{
    icons?: AgentInputModuleFactory;
    modal?: AgentInputModuleFactory;
    reactNative?: AgentInputModuleFactory;
    storage?: AgentInputStorageModuleFactory;
    storageStore?: AgentInputStorageStoreModuleFactory;
    text?: AgentInputModuleFactory;
    unistyles?: AgentInputModuleFactory;
}>;

const agentInputCommonModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as AgentInputModuleFactory | undefined,
        modal: undefined as AgentInputModuleFactory | undefined,
        reactNative: undefined as AgentInputModuleFactory | undefined,
        storage: undefined as AgentInputStorageModuleFactory | undefined,
        storageStore: undefined as AgentInputStorageStoreModuleFactory | undefined,
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
        storageStore: options.storageStore,
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

    vi.mock('@/hooks/ui/textInputCaretRect', () => ({
        useTextInputCaretRect: () => null,
    }));

    vi.mock('react-native-keyboard-controller', () => ({
        useFocusedInputHandler: () => {},
    }));

    vi.mock('react-native-reanimated', async (importOriginal) => {
        const original = await importOriginal<Record<string, unknown>>();
        return {
            ...original,
            runOnJS: <Args extends readonly unknown[], Return>(
                fn: (...args: Args) => Return,
            ) => fn,
        };
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

    vi.mock('@/sync/domains/state/storageStore', async () => {
        const activeOptions = agentInputCommonModuleState.options;
        if (activeOptions.storageStore) {
            return await activeOptions.storageStore();
        }

        return {
            getStorage: () => Object.assign(
                (selector?: (state: unknown) => unknown) => {
                    const state = { sessionMessages: {}, localSettings: { uiFontScale: 1 } };
                    return typeof selector === 'function' ? selector(state) : state;
                },
                { getState: () => ({ localSettings: { uiFontScale: 1 } }) },
            ),
        };
    });
}
