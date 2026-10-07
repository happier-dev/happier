import { vi } from 'vitest';

type PopoverModuleFactory = () => unknown | Promise<unknown>;

type InstallPopoverCommonModuleMocksOptions = Readonly<{
    reactNative?: PopoverModuleFactory;
}>;

const popoverModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as PopoverModuleFactory | undefined,
    },
}));

export function installPopoverCommonModuleMocks(
    options: InstallPopoverCommonModuleMocksOptions = {},
) {
    popoverModuleState.options = {
        reactNative: options.reactNative,
    };

    vi.mock('react-native', async () => {
        const activeOptions = popoverModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });
}
