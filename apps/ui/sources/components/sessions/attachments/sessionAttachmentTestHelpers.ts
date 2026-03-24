import { vi } from 'vitest';

type SessionAttachmentModuleFactory = () => unknown | Promise<unknown>;

type InstallSessionAttachmentCommonModuleMocksOptions = Readonly<{
    modal?: SessionAttachmentModuleFactory;
    reactNative?: SessionAttachmentModuleFactory;
    text?: SessionAttachmentModuleFactory;
    unistyles?: SessionAttachmentModuleFactory;
}>;

const sessionAttachmentModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as SessionAttachmentModuleFactory | undefined,
        reactNative: undefined as SessionAttachmentModuleFactory | undefined,
        text: undefined as SessionAttachmentModuleFactory | undefined,
        unistyles: undefined as SessionAttachmentModuleFactory | undefined,
    },
}));

export function installSessionAttachmentCommonModuleMocks(
    options: InstallSessionAttachmentCommonModuleMocksOptions = {},
): void {
    sessionAttachmentModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionAttachmentModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sessionAttachmentModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = sessionAttachmentModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sessionAttachmentModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });
}
