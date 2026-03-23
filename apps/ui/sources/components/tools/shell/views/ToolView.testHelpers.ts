import { vi } from 'vitest';

type ToolShellModuleFactory = () => unknown | Promise<unknown>;
type ToolShellStorageModuleFactory = (importOriginal: <T>() => Promise<T>) => unknown | Promise<unknown>;

type ToolShellCommonModuleMocksOptions = Readonly<{
    expoRouter?: ToolShellModuleFactory;
    reactNative?: ToolShellModuleFactory;
    storage?: ToolShellStorageModuleFactory;
    text?: ToolShellModuleFactory;
    unistyles?: ToolShellModuleFactory;
}>;

const toolShellCommonModuleMocksState = vi.hoisted(() => ({
    options: {} as ToolShellCommonModuleMocksOptions,
}));

export function installToolShellCommonModuleMocks(options: ToolShellCommonModuleMocksOptions = {}) {
    toolShellCommonModuleMocksState.options = options;

    vi.mock('expo-router', async () => {
        const activeOptions = toolShellCommonModuleMocksState.options;
        if (activeOptions.expoRouter) {
            return await activeOptions.expoRouter();
        }
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('react-native', async () => {
        const activeOptions = toolShellCommonModuleMocksState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = toolShellCommonModuleMocksState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = toolShellCommonModuleMocksState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = toolShellCommonModuleMocksState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {},
        });
    });
}

export {
    collectHostText,
    collectNodeText,
    findPressableByText,
    makeToolCall,
    makeToolViewProps,
} from '@/dev/testkit';
