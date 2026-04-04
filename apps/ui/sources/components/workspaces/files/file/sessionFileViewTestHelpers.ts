import * as React from 'react';
import { vi } from 'vitest';

type SessionFileViewModuleFactory = () => unknown | Promise<unknown>;

type InstallSessionFileViewCommonModuleMocksOptions = Readonly<{
    reactNative?: SessionFileViewModuleFactory;
    text?: SessionFileViewModuleFactory;
}>;

export function installSessionFileViewCommonModuleMocks(
    options: InstallSessionFileViewCommonModuleMocksOptions = {},
) {
    const activeOptions = {
        reactNative: options.reactNative,
        text: options.text,
    };

    vi.doMock('react-native', async () => {
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

    vi.doMock('@/text', async () => {
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });
}
