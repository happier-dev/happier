import { vi } from 'vitest';

type SourceControlChangesModuleFactory = () => unknown | Promise<unknown>;

type InstallSourceControlChangesCommonModuleMocksOptions = Readonly<{
    icons?: SourceControlChangesModuleFactory;
    modal?: SourceControlChangesModuleFactory;
    reactNative?: SourceControlChangesModuleFactory;
    text?: SourceControlChangesModuleFactory;
    typography?: SourceControlChangesModuleFactory;
    uiText?: SourceControlChangesModuleFactory;
    unistyles?: SourceControlChangesModuleFactory;
}>;

const sourceControlChangesModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as SourceControlChangesModuleFactory | undefined,
        modal: undefined as SourceControlChangesModuleFactory | undefined,
        reactNative: undefined as SourceControlChangesModuleFactory | undefined,
        text: undefined as SourceControlChangesModuleFactory | undefined,
        typography: undefined as SourceControlChangesModuleFactory | undefined,
        uiText: undefined as SourceControlChangesModuleFactory | undefined,
        unistyles: undefined as SourceControlChangesModuleFactory | undefined,
    },
}));

export function installSourceControlChangesCommonModuleMocks(
    options: InstallSourceControlChangesCommonModuleMocksOptions = {},
) {
    sourceControlChangesModuleState.options = {
        icons: options.icons,
        modal: options.modal,
        reactNative: options.reactNative,
        text: options.text,
        typography: options.typography,
        uiText: options.uiText,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sourceControlChangesModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sourceControlChangesModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = sourceControlChangesModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/components/ui/text/Text', async () => {
        const activeOptions = sourceControlChangesModuleState.options;
        if (activeOptions.uiText) {
            return await activeOptions.uiText();
        }

        return {
            Text: 'Text',
            TextInput: 'TextInput',
        };
    });

    vi.mock('@/constants/Typography', async () => {
        const activeOptions = sourceControlChangesModuleState.options;
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
        const activeOptions = sourceControlChangesModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sourceControlChangesModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });
}
