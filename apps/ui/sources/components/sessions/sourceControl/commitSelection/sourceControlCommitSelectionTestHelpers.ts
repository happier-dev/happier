import { vi } from 'vitest';

type SourceControlCommitSelectionModuleFactory = () => unknown | Promise<unknown>;

type InstallSourceControlCommitSelectionCommonModuleMocksOptions = Readonly<{
    icons?: SourceControlCommitSelectionModuleFactory;
    reactNative?: SourceControlCommitSelectionModuleFactory;
    text?: SourceControlCommitSelectionModuleFactory;
    typography?: SourceControlCommitSelectionModuleFactory;
    uiText?: SourceControlCommitSelectionModuleFactory;
    unistyles?: SourceControlCommitSelectionModuleFactory;
}>;

const sourceControlCommitSelectionModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as SourceControlCommitSelectionModuleFactory | undefined,
        reactNative: undefined as SourceControlCommitSelectionModuleFactory | undefined,
        text: undefined as SourceControlCommitSelectionModuleFactory | undefined,
        typography: undefined as SourceControlCommitSelectionModuleFactory | undefined,
        uiText: undefined as SourceControlCommitSelectionModuleFactory | undefined,
        unistyles: undefined as SourceControlCommitSelectionModuleFactory | undefined,
    },
}));

export function installSourceControlCommitSelectionCommonModuleMocks(
    options: InstallSourceControlCommitSelectionCommonModuleMocksOptions = {},
) {
    sourceControlCommitSelectionModuleState.options = {
        icons: options.icons,
        reactNative: options.reactNative,
        text: options.text,
        typography: options.typography,
        uiText: options.uiText,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sourceControlCommitSelectionModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sourceControlCommitSelectionModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = sourceControlCommitSelectionModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/components/ui/text/Text', async () => {
        const activeOptions = sourceControlCommitSelectionModuleState.options;
        if (activeOptions.uiText) {
            return await activeOptions.uiText();
        }

        return {
            Text: 'Text',
            TextInput: 'TextInput',
        };
    });

    vi.mock('@/constants/Typography', async () => {
        const activeOptions = sourceControlCommitSelectionModuleState.options;
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
        const activeOptions = sourceControlCommitSelectionModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });
}
