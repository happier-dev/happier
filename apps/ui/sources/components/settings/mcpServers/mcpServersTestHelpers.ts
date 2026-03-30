import * as React from 'react';
import { vi } from 'vitest';

import type { ExpoRouterParams } from '@/dev/testkit/mocks/router';

type McpServersModuleFactory = () => unknown | Promise<unknown>;
type McpServersImportOriginal = <T = unknown>() => Promise<T>;
type McpServersStorageModuleFactory = (
    importOriginal: McpServersImportOriginal,
) => unknown | Promise<unknown>;

type InstallMcpServersCommonModuleMocksOptions = Readonly<{
    modal?: McpServersModuleFactory;
    reactNative?: McpServersModuleFactory;
    router?: McpServersModuleFactory;
    routerSearchParams?: ExpoRouterParams;
    storage?: McpServersStorageModuleFactory;
    text?: McpServersModuleFactory;
    unistyles?: McpServersModuleFactory;
}>;

const mcpServersModuleState = vi.hoisted(() => ({
    openMachinePathBrowserModalSpy: vi.fn<(params: unknown) => Promise<string | null>>(async () => null),
    routerBackSpy: vi.fn(),
    routerPushSpy: vi.fn(),
    routerReplaceSpy: vi.fn(),
    routerSetParamsSpy: vi.fn(),
    routerSearchParams: {} as ExpoRouterParams,
    options: {
        modal: undefined as McpServersModuleFactory | undefined,
        reactNative: undefined as McpServersModuleFactory | undefined,
        router: undefined as McpServersModuleFactory | undefined,
        storage: undefined as McpServersStorageModuleFactory | undefined,
        text: undefined as McpServersModuleFactory | undefined,
        unistyles: undefined as McpServersModuleFactory | undefined,
    },
}));

export function resetMcpServersCommonModuleMockState() {
    mcpServersModuleState.openMachinePathBrowserModalSpy.mockReset();
    mcpServersModuleState.openMachinePathBrowserModalSpy.mockResolvedValue(null);
    mcpServersModuleState.routerBackSpy.mockClear();
    mcpServersModuleState.routerPushSpy.mockClear();
    mcpServersModuleState.routerReplaceSpy.mockClear();
    mcpServersModuleState.routerSetParamsSpy.mockClear();
    mcpServersModuleState.routerSearchParams = {};
    mcpServersModuleState.options = {
        modal: undefined,
        reactNative: undefined,
        router: undefined,
        storage: undefined,
        text: undefined,
        unistyles: undefined,
    };
}

export function installMcpServersCommonModuleMocks(
    options: InstallMcpServersCommonModuleMocksOptions = {},
) {
    mcpServersModuleState.routerSearchParams = options.routerSearchParams ?? {};
    mcpServersModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

    vi.mock('@expo/vector-icons', () => ({
        Ionicons: 'Ionicons',
    }));

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = mcpServersModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = mcpServersModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = mcpServersModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = mcpServersModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: {
                back: mcpServersModuleState.routerBackSpy,
                push: mcpServersModuleState.routerPushSpy,
                replace: mcpServersModuleState.routerReplaceSpy,
                setParams: mcpServersModuleState.routerSetParamsSpy,
            },
        });

        return {
            ...routerMock.module,
            useLocalSearchParams: () => mcpServersModuleState.routerSearchParams,
            useGlobalSearchParams: () => mcpServersModuleState.routerSearchParams,
        };
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = mcpServersModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useAllMachines: () => [],
            useMachineListByServerId: () => ({}),
            useMachineListStatusByServerId: () => ({}),
            useSettingMutable: () => [null, vi.fn()],
        });
    });

    vi.mock('@/components/ui/text/Text', () => ({
        Text: 'Text',
        TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
    }));

    vi.mock('@/components/ui/lists/ItemList', () => ({
        ItemList: ({ children }: React.PropsWithChildren) => React.createElement('ItemList', null, children),
    }));

    vi.mock('@/components/ui/lists/ItemGroup', () => ({
        ItemGroup: ({ children }: React.PropsWithChildren) => React.createElement('ItemGroup', null, children),
    }));

    vi.mock('@/components/ui/lists/Item', () => ({
        Item: (props: Record<string, unknown> & {
            children?: React.ReactNode;
            rightElement?: React.ReactNode;
            subtitle?: React.ReactNode;
            subtitleAccessory?: React.ReactNode;
        }) =>
            React.createElement(
                'Item',
                props,
                props.children ?? null,
                props.subtitle ?? null,
                props.subtitleAccessory ?? null,
                props.rightElement ?? null,
            ),
    }));

    vi.mock('@/components/ui/lists/ItemRowActions', () => ({
        ItemRowActions: (props: Record<string, unknown>) => React.createElement('ItemRowActions', props),
    }));

    vi.mock('@/components/ui/buttons/RoundButton', () => ({
        RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
    }));

    vi.mock('@/components/ui/navigation/SegmentedTabBar', () => ({
        SegmentedTabBar: (props: Record<string, unknown>) => React.createElement('SegmentedTabBar', props),
    }));

    vi.mock('@/components/ui/forms/Switch', () => ({
        Switch: (props: Record<string, unknown>) => React.createElement('Switch', props),
    }));

    vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
        DropdownMenu: (props: Record<string, unknown> & {
            itemTrigger?: { subtitle?: unknown; title?: unknown };
            subtitle?: unknown;
            title?: unknown;
        }) =>
            React.createElement('DropdownMenu', {
                ...props,
                title: props.itemTrigger?.title ?? props.title,
                subtitle: props.itemTrigger?.subtitle ?? props.subtitle,
            }),
    }));

    vi.mock('@/components/ui/pathBrowser/PathInputBrowseButton', () => ({
        PathInputBrowseButton: (props: Record<string, unknown> & {
            disabled?: boolean;
            onPress?: () => unknown;
            testID?: string;
        }) =>
            React.createElement('PathInputBrowseButton', {
                ...props,
                testID: props.testID ?? 'path-browser-trigger',
            }),
    }));

    vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
        openMachinePathBrowserModal: (params: unknown) =>
            mcpServersModuleState.openMachinePathBrowserModalSpy(params),
    }));

    vi.mock('@/components/ui/layout/layout', () => ({
        layout: { maxWidth: 960 },
    }));
}

export { mcpServersModuleState };
