import { vi } from 'vitest';

type PathBrowserModuleFactory = () => unknown | Promise<unknown>;

type InstallPathBrowserCommonModuleMocksOptions = Readonly<{
    reactNative?: PathBrowserModuleFactory;
    text?: PathBrowserModuleFactory;
    unistyles?: PathBrowserModuleFactory;
}>;

const pathBrowserModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as PathBrowserModuleFactory | undefined,
        text: undefined as PathBrowserModuleFactory | undefined,
        unistyles: undefined as PathBrowserModuleFactory | undefined,
    },
}));

vi.mock('react-native', async () => {
    const activeOptions = pathBrowserModuleState.options;
    if (activeOptions.reactNative) {
        return await activeOptions.reactNative();
    }

    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const activeOptions = pathBrowserModuleState.options;
    if (activeOptions.unistyles) {
        return await activeOptions.unistyles();
    }

    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const activeOptions = pathBrowserModuleState.options;
    if (activeOptions.text) {
        return await activeOptions.text();
    }

    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

export function installPathBrowserCommonModuleMocks(
    options: InstallPathBrowserCommonModuleMocksOptions = {},
): void {
    pathBrowserModuleState.options = {
        reactNative: options.reactNative,
        text: options.text,
        unistyles: options.unistyles,
    };
}
