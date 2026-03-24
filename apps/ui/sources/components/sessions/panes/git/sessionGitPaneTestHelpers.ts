import * as React from 'react';
import { vi } from 'vitest';

type SessionGitPaneModuleFactory = () => unknown | Promise<unknown>;
type SessionGitPaneImportOriginal = <T = unknown>() => Promise<T>;
type SessionGitPaneStorageModuleFactory = (
    importOriginal: SessionGitPaneImportOriginal,
) => unknown | Promise<unknown>;

type InstallSessionGitPaneCommonModuleMocksOptions = Readonly<{
    icons?: SessionGitPaneModuleFactory;
    reactNative?: SessionGitPaneModuleFactory;
    scrollEdgeFades?: SessionGitPaneModuleFactory;
    scrollEdgeFadesHook?: SessionGitPaneModuleFactory;
    storage?: SessionGitPaneStorageModuleFactory;
    text?: SessionGitPaneModuleFactory;
    typography?: SessionGitPaneModuleFactory;
    uiText?: SessionGitPaneModuleFactory;
}>;

const sessionGitPaneModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as SessionGitPaneModuleFactory | undefined,
        reactNative: undefined as SessionGitPaneModuleFactory | undefined,
        scrollEdgeFades: undefined as SessionGitPaneModuleFactory | undefined,
        scrollEdgeFadesHook: undefined as SessionGitPaneModuleFactory | undefined,
        storage: undefined as SessionGitPaneStorageModuleFactory | undefined,
        text: undefined as SessionGitPaneModuleFactory | undefined,
        typography: undefined as SessionGitPaneModuleFactory | undefined,
        uiText: undefined as SessionGitPaneModuleFactory | undefined,
    },
}));

export function installSessionGitPaneCommonModuleMocks(
    options: InstallSessionGitPaneCommonModuleMocksOptions = {},
) {
    sessionGitPaneModuleState.options = {
        icons: options.icons,
        reactNative: options.reactNative,
        scrollEdgeFades: options.scrollEdgeFades,
        scrollEdgeFadesHook: options.scrollEdgeFadesHook,
        storage: options.storage,
        text: options.text,
        typography: options.typography,
        uiText: options.uiText,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionGitPaneModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = sessionGitPaneModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/components/ui/text/Text', async () => {
        const activeOptions = sessionGitPaneModuleState.options;
        if (activeOptions.uiText) {
            return await activeOptions.uiText();
        }

        return {
            Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
                React.createElement('Text', props, children),
            TextInput: 'TextInput',
        };
    });

    vi.mock('@/components/ui/scroll/useScrollEdgeFades', async () => {
        const activeOptions = sessionGitPaneModuleState.options;
        if (activeOptions.scrollEdgeFadesHook) {
            return await activeOptions.scrollEdgeFadesHook();
        }

        return {
            useScrollEdgeFades: () => ({
                visibility: { top: false, bottom: false, left: false, right: false },
                onViewportLayout: () => {},
                onContentSizeChange: () => {},
                onScroll: () => {},
            }),
        };
    });

    vi.mock('@/components/ui/scroll/ScrollEdgeFades', async () => {
        const activeOptions = sessionGitPaneModuleState.options;
        if (activeOptions.scrollEdgeFades) {
            return await activeOptions.scrollEdgeFades();
        }

        return {
            ScrollEdgeFades: (props: Record<string, unknown>) =>
                React.createElement('ScrollEdgeFades', props),
        };
    });

    vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', async () => {
        const activeOptions = sessionGitPaneModuleState.options;
        if (activeOptions.scrollEdgeFades) {
            return await activeOptions.scrollEdgeFades();
        }

        return {
            ScrollEdgeIndicators: (props: Record<string, unknown>) =>
                React.createElement('ScrollEdgeIndicators', props),
        };
    });

    vi.mock('@/constants/Typography', async () => {
        const activeOptions = sessionGitPaneModuleState.options;
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
        const activeOptions = sessionGitPaneModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = sessionGitPaneModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
