import { vi } from 'vitest';

type SessionFilesModuleFactory = () => unknown | Promise<unknown>;

type InstallSessionFilesCommonModuleMocksOptions = Readonly<{
    icons?: SessionFilesModuleFactory;
    reactNative?: SessionFilesModuleFactory;
    text?: SessionFilesModuleFactory;
    uiText?: SessionFilesModuleFactory;
    typography?: SessionFilesModuleFactory;
}>;

const sessionFilesModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as SessionFilesModuleFactory | undefined,
        reactNative: undefined as SessionFilesModuleFactory | undefined,
        text: undefined as SessionFilesModuleFactory | undefined,
        uiText: undefined as SessionFilesModuleFactory | undefined,
        typography: undefined as SessionFilesModuleFactory | undefined,
    },
}));

export function installSessionFilesCommonModuleMocks(
    options: InstallSessionFilesCommonModuleMocksOptions = {},
) {
    sessionFilesModuleState.options = {
        icons: options.icons,
        reactNative: options.reactNative,
        text: options.text,
        uiText: options.uiText,
        typography: options.typography,
    };

    vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = sessionFilesModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/components/ui/text/Text', async () => {
        const activeOptions = sessionFilesModuleState.options;
        if (activeOptions.uiText) {
            return await activeOptions.uiText();
        }

        return {
            Text: 'Text',
            TextInput: 'TextInput',
        };
    });

    vi.mock('@/constants/Typography', async () => {
        const activeOptions = sessionFilesModuleState.options;
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
        const activeOptions = sessionFilesModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });
}
