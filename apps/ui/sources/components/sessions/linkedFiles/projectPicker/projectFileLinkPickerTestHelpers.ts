import { vi } from 'vitest';

type ProjectFileLinkPickerModuleFactory = () => unknown | Promise<unknown>;
type ProjectFileLinkPickerImportOriginal = <T = unknown>() => Promise<T>;
type ProjectFileLinkPickerStorageModuleFactory = (
    importOriginal: ProjectFileLinkPickerImportOriginal,
) => unknown | Promise<unknown>;

type InstallProjectFileLinkPickerCommonModuleMocksOptions = Readonly<{
    icons?: ProjectFileLinkPickerModuleFactory;
    modal?: ProjectFileLinkPickerModuleFactory;
    reactNative?: ProjectFileLinkPickerModuleFactory;
    router?: ProjectFileLinkPickerModuleFactory;
    storage?: ProjectFileLinkPickerStorageModuleFactory;
    text?: ProjectFileLinkPickerModuleFactory;
    typography?: ProjectFileLinkPickerModuleFactory;
    uiText?: ProjectFileLinkPickerModuleFactory;
    unistyles?: ProjectFileLinkPickerModuleFactory;
}>;

const projectFileLinkPickerModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as ProjectFileLinkPickerModuleFactory | undefined,
        modal: undefined as ProjectFileLinkPickerModuleFactory | undefined,
        reactNative: undefined as ProjectFileLinkPickerModuleFactory | undefined,
        router: undefined as ProjectFileLinkPickerModuleFactory | undefined,
        storage: undefined as ProjectFileLinkPickerStorageModuleFactory | undefined,
        text: undefined as ProjectFileLinkPickerModuleFactory | undefined,
        typography: undefined as ProjectFileLinkPickerModuleFactory | undefined,
        uiText: undefined as ProjectFileLinkPickerModuleFactory | undefined,
        unistyles: undefined as ProjectFileLinkPickerModuleFactory | undefined,
    },
}));

export function installProjectFileLinkPickerCommonModuleMocks(
    options: InstallProjectFileLinkPickerCommonModuleMocksOptions = {},
) {
    projectFileLinkPickerModuleState.options = {
        icons: options.icons,
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        typography: options.typography,
        uiText: options.uiText,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = projectFileLinkPickerModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = projectFileLinkPickerModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = projectFileLinkPickerModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/components/ui/text/Text', async () => {
        const activeOptions = projectFileLinkPickerModuleState.options;
        if (activeOptions.uiText) {
            return await activeOptions.uiText();
        }

        return {
            Text: 'Text',
            TextInput: 'TextInput',
        };
    });

    vi.mock('@/constants/Typography', async () => {
        const activeOptions = projectFileLinkPickerModuleState.options;
        if (activeOptions.typography) {
            return await activeOptions.typography();
        }

        return {
            Typography: {
                default: () => ({}),
                mono: () => ({}),
            },
        };
    });

    vi.mock('@/text', async () => {
        const activeOptions = projectFileLinkPickerModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = projectFileLinkPickerModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = projectFileLinkPickerModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = projectFileLinkPickerModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
