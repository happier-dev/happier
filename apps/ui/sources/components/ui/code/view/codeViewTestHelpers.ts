import { vi } from 'vitest';

type CodeViewModuleFactory = () => unknown | Promise<unknown>;

type InstallCodeViewCommonModuleMocksOptions = Readonly<{
    icons?: CodeViewModuleFactory;
    reactNative?: CodeViewModuleFactory;
    unistyles?: CodeViewModuleFactory;
    realVirtualizer?: boolean;
}>;

const codeViewModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as CodeViewModuleFactory | undefined,
        reactNative: undefined as CodeViewModuleFactory | undefined,
        unistyles: undefined as CodeViewModuleFactory | undefined,
        realVirtualizer: false,
    },
    listRef: {
        scrollToIndex: vi.fn(),
        scrollToOffset: vi.fn(),
        getNativeScrollRef: vi.fn(),
        getScrollableNode: vi.fn(),
    },
}));

export const codeViewListRef = codeViewModuleState.listRef;

export function installCodeViewCommonModuleMocks(
    options: InstallCodeViewCommonModuleMocksOptions = {},
) {
    codeViewModuleState.options = {
        icons: options.icons,
        reactNative: options.reactNative,
        unistyles: options.unistyles,
        realVirtualizer: options.realVirtualizer ?? false,
    };

    vi.mock('@legendapp/list/react-native', async (importOriginal) => {
        const original = await importOriginal<Record<string, unknown>>();
        if (codeViewModuleState.options.realVirtualizer) return original;
        const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
        return createCapturingLegendListMock({ original, refHandle: codeViewModuleState.listRef }).module;
    });

    vi.mock('react-native', async () => {
        const activeOptions = codeViewModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = codeViewModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = codeViewModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });
}
