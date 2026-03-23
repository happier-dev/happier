import * as React from 'react';
import { vi } from 'vitest';

type SessionFileViewModuleFactory = () => unknown | Promise<unknown>;

type InstallSessionFileViewCommonModuleMocksOptions = Readonly<{
    reactNative?: SessionFileViewModuleFactory;
    text?: SessionFileViewModuleFactory;
}>;

const sessionFileViewModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as SessionFileViewModuleFactory | undefined,
        text: undefined as SessionFileViewModuleFactory | undefined,
    },
}));

export function installSessionFileViewCommonModuleMocks(
    options: InstallSessionFileViewCommonModuleMocksOptions = {},
) {
    sessionFileViewModuleState.options = {
        reactNative: options.reactNative,
        text: options.text,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionFileViewModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (options: any) => options?.web ?? options?.default ?? null,
            },
            AppState: {
                currentState: 'active',
                addEventListener: () => ({ remove: () => {} }),
            },
            View: (props: any) => React.createElement('View', props, props.children),
            ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
        });
    });

    vi.mock('@/text', async () => {
        const activeOptions = sessionFileViewModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });
}
