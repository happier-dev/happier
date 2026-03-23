import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ITEM_TEST_ID = 'item-double-press-target';

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
    handlerName: 'onPress' | 'onDoubleClick',
    event: Record<string, unknown>,
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
                OS: 'web',
                select: (values: any) => values?.default ?? values?.web ?? values?.ios ?? values?.android,
            },
            AppState: {
                currentState: 'active',
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
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

describe('Item (double press)', () => {
    it('wires onDoublePress to onDoubleClick on web', async () => {
        const onPress = vi.fn();
        const onDoublePress = vi.fn();
        const { Item } = await import('./Item');

        const screen = await renderScreen(
            <Item
                testID={ITEM_TEST_ID}
                title="Hello"
                onPress={onPress}
                onDoublePress={onDoublePress}
                showChevron={false}
            />,
        );
        const pressable = getItemPressable(screen);
        expect(typeof pressable.props.onDoubleClick).toBe('function');

        await invokeItemHandler(pressable, 'onDoubleClick', {});

        expect(onDoublePress).toHaveBeenCalledTimes(1);
        expect(onPress).toHaveBeenCalledTimes(0);
    });

    it('treats two quick presses as a double press on web', async () => {
        const onPress = vi.fn();
        const onDoublePress = vi.fn();
        const { Item } = await import('./Item');

        const screen = await renderScreen(
            <Item
                testID={ITEM_TEST_ID}
                title="Hello"
                onPress={onPress}
                onDoublePress={onDoublePress}
                showChevron={false}
            />,
        );
        const pressable = getItemPressable(screen);
        expect(typeof pressable.props.onPress).toBe('function');

        await invokeItemHandler(pressable, 'onPress', { nativeEvent: { detail: 1 } });

        expect(onPress).toHaveBeenCalledTimes(1);
        expect(onDoublePress).toHaveBeenCalledTimes(0);

        await invokeItemHandler(pressable, 'onPress', { nativeEvent: { detail: 1 } });

        expect(onPress).toHaveBeenCalledTimes(1);
        expect(onDoublePress).toHaveBeenCalledTimes(1);
    });

    it('does not fire onPress immediately after onDoubleClick on web', async () => {
        const onPress = vi.fn();
        const onDoublePress = vi.fn();
        const { Item } = await import('./Item');

        const screen = await renderScreen(
            <Item
                testID={ITEM_TEST_ID}
                title="Hello"
                onPress={onPress}
                onDoublePress={onDoublePress}
                showChevron={false}
            />,
        );
        const pressable = getItemPressable(screen);
        expect(typeof pressable.props.onDoubleClick).toBe('function');
        expect(typeof pressable.props.onPress).toBe('function');

        await invokeItemHandler(pressable, 'onDoubleClick', { preventDefault: vi.fn(), stopPropagation: vi.fn() });

        // Some RN web builds dispatch an onPress after onDoubleClick; ensure we ignore it so a pinned-open
        // is not immediately overwritten by a preview-open.
        await invokeItemHandler(pressable, 'onPress', {
            nativeEvent: { detail: 1 },
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        });

        expect(onDoublePress).toHaveBeenCalledTimes(1);
        expect(onPress).toHaveBeenCalledTimes(0);
    });

    it('treats web click detail=1 as a single press', async () => {
        const onPress = vi.fn();
        const onDoublePress = vi.fn();
        const { Item } = await import('./Item');

        const screen = await renderScreen(
            <Item
                testID={ITEM_TEST_ID}
                title="Hello"
                onPress={onPress}
                onDoublePress={onDoublePress}
                showChevron={false}
            />,
        );
        const pressable = getItemPressable(screen);

        await invokeItemHandler(pressable, 'onPress', { nativeEvent: { detail: 1 } });

        expect(onPress).toHaveBeenCalledTimes(1);
        expect(onDoublePress).toHaveBeenCalledTimes(0);
    });
});
