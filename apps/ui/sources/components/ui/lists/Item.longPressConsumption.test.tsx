import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ITEM_TEST_ID = 'item-long-press-target';
const modalAlertSpy = vi.hoisted(() => vi.fn());
const platformState = vi.hoisted(() => ({
    os: 'web' as 'ios' | 'android' | 'web',
}));

function requireTestIdNode(node: ReactTestInstance | null): ReactTestInstance {
    if (!node) {
        throw new Error(`Unable to find testID "${ITEM_TEST_ID}"`);
    }

    return node;
}

function getItemPressable(screen: { findByTestId: (testID: string) => ReactTestInstance | null }): ReactTestInstance {
    return requireTestIdNode(screen.findByTestId(ITEM_TEST_ID));
}

async function invokeItemHandler(
    pressable: ReactTestInstance,
    handlerName: 'onLongPress' | 'onPress',
    event: Record<string, unknown> = {},
): Promise<void> {
    await act(async () => {
        invokeTestInstanceHandler(pressable, handlerName, event);
    });
}

installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            ActivityIndicator: 'ActivityIndicator',
            Platform: {
                get OS() {
                    return platformState.os;
                },
                select: (values: any) => values?.[platformState.os] ?? values?.default ?? values?.web ?? values?.ios ?? values?.android,
            },
            AppState: {
                currentState: 'active',
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alert: modalAlertSpy } }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                dark: false,
                colors: {
                    text: '#fff',
                    textSecondary: '#aaa',
                    surfacePressedOverlay: 'rgba(0,0,0,0.1)',
                    surfaceSelected: 'rgba(255,255,255,0.1)',
                    surfaceRipple: 'rgba(0,0,0,0.1)',
                    surfaceHigh: '#222',
                    surfaceHighest: '#333',
                    divider: '#444',
                    groupped: {
                        background: '#111',
                        chevron: '#888',
                    },
                },
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => 'middle',
}));

vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => ({}),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

describe('Item (long press)', () => {
    beforeEach(() => {
        platformState.os = 'web';
        modalAlertSpy.mockClear();
    });

    it('suppresses onPress immediately after onLongPress', async () => {
        const onPress = vi.fn();
        const onLongPress = vi.fn();
        const { Item } = await import('./Item');

        const screen = await renderScreen(
            <Item
                testID={ITEM_TEST_ID}
                title="Hello"
                onPress={onPress}
                onLongPress={onLongPress}
                showChevron={false}
            />,
        );
        const pressable = getItemPressable(screen);
        expect(typeof pressable.props.onLongPress).toBe('function');
        expect(typeof pressable.props.onPress).toBe('function');

        await invokeItemHandler(pressable, 'onLongPress');
        await invokeItemHandler(pressable, 'onPress', { nativeEvent: { detail: 1 } });

        expect(onLongPress).toHaveBeenCalledTimes(1);
        expect(onPress).toHaveBeenCalledTimes(0);

        await invokeItemHandler(pressable, 'onPress', { nativeEvent: { detail: 1 } });
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('copies native copy rows from Pressable long press without opening a success modal', async () => {
        platformState.os = 'android';
        vi.resetModules();
        const Clipboard = await import('expo-clipboard');
        const { Item } = await import('./Item');

        const screen = await renderScreen(
            <Item
                testID={ITEM_TEST_ID}
                title="Log path"
                subtitle="/tmp/session.log"
                copy
                showChevron={false}
            />,
        );
        const pressable = getItemPressable(screen);

        await invokeItemHandler(pressable, 'onLongPress');
        await invokeItemHandler(pressable, 'onPress', { nativeEvent: { detail: 1 } });

        expect(Clipboard.setStringAsync).toHaveBeenCalledWith('/tmp/session.log');
        expect(modalAlertSpy).not.toHaveBeenCalledWith('common.copied', expect.anything());
        expect(screen.findByTestId('item-copy-feedback')).toBeTruthy();
    });

    it('copies web copy rows from Pressable press without opening a success modal', async () => {
        platformState.os = 'web';
        vi.resetModules();
        const Clipboard = await import('expo-clipboard');
        const { Item } = await import('./Item');

        const screen = await renderScreen(
            <Item
                testID={ITEM_TEST_ID}
                title="Log path"
                subtitle="/tmp/session.log"
                copy
                showChevron={false}
            />,
        );
        const pressable = getItemPressable(screen);

        await invokeItemHandler(pressable, 'onPress', { nativeEvent: { detail: 1 } });

        expect(Clipboard.setStringAsync).toHaveBeenCalledWith('/tmp/session.log');
        expect(modalAlertSpy).not.toHaveBeenCalledWith('common.copied', expect.anything());
        expect(screen.findByTestId('item-copy-feedback')).toBeTruthy();
    });
});
