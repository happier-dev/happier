import { vi } from 'vitest';

type ContextBarModuleFactory = () => unknown | Promise<unknown>;

type InstallContextBarCommonModuleMocksOptions = Readonly<{
    reactNative?: ContextBarModuleFactory;
    text?: ContextBarModuleFactory;
    unistyles?: ContextBarModuleFactory;
}>;

const contextBarModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as ContextBarModuleFactory | undefined,
        text: undefined as ContextBarModuleFactory | undefined,
        unistyles: undefined as ContextBarModuleFactory | undefined,
    },
}));

export function installContextBarCommonModuleMocks(
    options: InstallContextBarCommonModuleMocksOptions = {},
): void {
    contextBarModuleState.options = {
        reactNative: options.reactNative,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = contextBarModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            Platform: {
                OS: 'web',
                select: <T,>(options: { default?: T; web?: T }) => options.web ?? options.default ?? null,
            },
        });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = contextBarModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = contextBarModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });
}
