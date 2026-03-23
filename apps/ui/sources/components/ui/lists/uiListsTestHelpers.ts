import { vi } from 'vitest';

type UiListsModuleFactory = () => unknown | Promise<unknown>;

type InstallUiListsCommonModuleMocksOptions = Readonly<{
    modal?: UiListsModuleFactory;
    reactNative?: UiListsModuleFactory;
    text?: UiListsModuleFactory;
    unistyles?: UiListsModuleFactory;
}>;

const uiListsModuleState = vi.hoisted(() => ({
    modalMockRef: { current: null as any },
    options: {
        modal: undefined as UiListsModuleFactory | undefined,
        reactNative: undefined as UiListsModuleFactory | undefined,
        text: undefined as UiListsModuleFactory | undefined,
        unistyles: undefined as UiListsModuleFactory | undefined,
    },
}));

export function getUiListsModalMockRef() {
    return uiListsModuleState.modalMockRef as { current: any };
}

export function resetUiListsCommonModuleMockState() {
    uiListsModuleState.modalMockRef.current = null;
}

export function installUiListsCommonModuleMocks(
    options: InstallUiListsCommonModuleMocksOptions = {},
) {
    uiListsModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = uiListsModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = uiListsModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = uiListsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = uiListsModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalMock = createModalModuleMock();
        uiListsModuleState.modalMockRef.current = modalMock;
        return modalMock.module;
    });
}
