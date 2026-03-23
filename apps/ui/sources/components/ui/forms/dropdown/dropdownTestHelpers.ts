import { vi } from 'vitest';

type DropdownModuleFactory = () => unknown | Promise<unknown>;

type InstallDropdownCommonModuleMocksOptions = Readonly<{
    modal?: DropdownModuleFactory;
    reactNative?: DropdownModuleFactory;
    text?: DropdownModuleFactory;
    unistyles?: DropdownModuleFactory;
}>;

const dropdownModuleState = vi.hoisted(() => ({
    modalMockRef: { current: null as any },
    options: {
        modal: undefined as DropdownModuleFactory | undefined,
        reactNative: undefined as DropdownModuleFactory | undefined,
        text: undefined as DropdownModuleFactory | undefined,
        unistyles: undefined as DropdownModuleFactory | undefined,
    },
}));

export function getDropdownModalMockRef() {
    return dropdownModuleState.modalMockRef as { current: any };
}

export function resetDropdownCommonModuleMockState() {
    dropdownModuleState.modalMockRef.current = null;
}

export function installDropdownCommonModuleMocks(
    options: InstallDropdownCommonModuleMocksOptions = {},
) {
    dropdownModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = dropdownModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = dropdownModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = dropdownModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = dropdownModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalMock = createModalModuleMock();
        dropdownModuleState.modalMockRef.current = modalMock;
        return modalMock.module;
    });
}
