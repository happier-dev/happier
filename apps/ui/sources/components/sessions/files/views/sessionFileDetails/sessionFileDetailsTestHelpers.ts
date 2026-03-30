import { vi } from 'vitest';

type SessionFileDetailsModuleFactory = () => unknown | Promise<unknown>;

type InstallSessionFileDetailsCommonModuleMocksOptions = Readonly<{
    modal?: SessionFileDetailsModuleFactory;
    reactNative?: SessionFileDetailsModuleFactory;
    text?: SessionFileDetailsModuleFactory;
}>;

const sessionFileDetailsModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as SessionFileDetailsModuleFactory | undefined,
        reactNative: undefined as SessionFileDetailsModuleFactory | undefined,
        text: undefined as SessionFileDetailsModuleFactory | undefined,
    },
}));

export function installSessionFileDetailsCommonModuleMocks(
    options: InstallSessionFileDetailsCommonModuleMocksOptions = {},
) {
    sessionFileDetailsModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        text: options.text,
    };

    vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

    vi.mock('@/text', async () => {
        const activeOptions = sessionFileDetailsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sessionFileDetailsModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });
}
