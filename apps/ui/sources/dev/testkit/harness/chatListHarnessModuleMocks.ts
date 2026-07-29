import type { ReactNode } from 'react';
import { vi } from 'vitest';

type ChatListHarnessModuleFactory = () => unknown | Promise<unknown>;
type ChatListHarnessImportOriginal = <T = unknown>() => Promise<T>;
type ChatListHarnessStorageModuleFactory = (
    importOriginal: ChatListHarnessImportOriginal,
) => unknown | Promise<unknown>;

type InstallChatListHarnessCommonModuleMocksOptions = Readonly<{
    legendList?: ChatListHarnessModuleFactory;
    reactNative?: ChatListHarnessModuleFactory;
    storage?: ChatListHarnessStorageModuleFactory;
    unistyles?: ChatListHarnessModuleFactory;
}>;

const chatListHarnessModuleState = vi.hoisted(() => ({
    options: {
        legendList: undefined as ChatListHarnessModuleFactory | undefined,
        reactNative: undefined as ChatListHarnessModuleFactory | undefined,
        storage: undefined as ChatListHarnessStorageModuleFactory | undefined,
        unistyles: undefined as ChatListHarnessModuleFactory | undefined,
    },
}));

export function installChatListHarnessCommonModuleMocks(
    options: InstallChatListHarnessCommonModuleMocksOptions = {},
) {
    chatListHarnessModuleState.options = {
        legendList: options.legendList,
        reactNative: options.reactNative,
        storage: options.storage,
        unistyles: options.unistyles,
    };

    vi.mock('@legendapp/list/react-native', async () => {
        const activeOptions = chatListHarnessModuleState.options;
        if (activeOptions.legendList) {
            return await activeOptions.legendList();
        }
        const { createLegendChatListModuleMock } = await import('@/dev/testkit/harness/chatListHarness');
        return createLegendChatListModuleMock();
    });

    vi.mock('react-native', async () => {
        const activeOptions = chatListHarnessModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createChatListHarnessReactNativeMock } = await import('@/dev/testkit/harness/chatListHarness');
        return createChatListHarnessReactNativeMock();
    });

    vi.mock('@/utils/platform/responsive', () => ({
        useHeaderHeight: () => 0,
    }));

    vi.mock('@/components/sessions/shell/useSessionScreenIsFocused', async () => {
        const React = await import('react');
        const {
            chatListHarnessState,
            subscribeChatListHarnessSessionScreenFocus,
        } = await import('@/dev/testkit/harness/chatListHarness');
        return {
            useSessionScreenIsFocused: () => React.useSyncExternalStore(
                subscribeChatListHarnessSessionScreenFocus,
                () => chatListHarnessState.sessionScreenIsFocused !== false,
            ),
        };
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = chatListHarnessModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('react-native-safe-area-context', () => ({
        useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    }));

    vi.mock('@react-native-masked-view/masked-view', async () => {
        const React = await import('react');
        return {
            default: (props: Readonly<{ children?: ReactNode }>) => React.createElement(
                React.Fragment,
                null,
                props.children,
            ),
        };
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = chatListHarnessModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createChatListHarnessStorageMock } = await import('@/dev/testkit/harness/chatListHarness');
        return createChatListHarnessStorageMock(importOriginal);
    });

    vi.mock('@/sync/domains/state/storageStore', async (importOriginal) => {
        const { createChatListHarnessStorageStoreMock } = await import('@/dev/testkit/harness/chatListHarness');
        return createChatListHarnessStorageStoreMock(importOriginal);
    });

    vi.mock('@/sync/store/hooks', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
        const { chatListHarnessState } = await import('@/dev/testkit/harness/chatListHarness');
        return {
            ...actual,
            useActiveServerAccountScope: () => chatListHarnessState.activeServerAccountScope,
        };
    });
}
