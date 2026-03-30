import * as React from 'react';
import { vi } from 'vitest';

type CardModuleFactory = () => unknown | Promise<unknown>;

type InstallCardCommonModuleMocksOptions = Readonly<{
    reactNative?: CardModuleFactory;
    unistyles?: CardModuleFactory;
}>;

const cardModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as CardModuleFactory | undefined,
        unistyles: undefined as CardModuleFactory | undefined,
    },
}));

export function installCardCommonModuleMocks(
    options: InstallCardCommonModuleMocksOptions = {},
): void {
    cardModuleState.options = {
        reactNative: options.reactNative,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: {
                        OS: 'web',
                    },
                    View: 'View',
                    Text: 'Text',
                    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                }
    );
});

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = cardModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/components/ui/text/Text', () => ({
        Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    }));

    vi.mock('@/constants/Typography', () => ({
        Typography: { default: () => ({}) },
    }));
}
