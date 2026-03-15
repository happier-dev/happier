import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    Platform: {
        OS: 'web',
        select: (values: any) => values?.default ?? values?.web ?? values?.ios ?? values?.android,
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
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
    }),
    StyleSheet: { create: (input: any) => (typeof input === 'function' ? input({ colors: { divider: '#444', groupped: { chevron: '#888' } } }, {}) : input) },
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

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Item
                    title="Hello"
                    onPress={onPress}
                    onDoublePress={onDoublePress}
                    showChevron={false}
                />
            );
        });

        const pressable = (tree! as any).root.findByType('Pressable');
        expect(typeof pressable.props.onDoubleClick).toBe('function');

        await act(async () => {
            pressable.props.onDoubleClick({});
        });

        expect(onDoublePress).toHaveBeenCalledTimes(1);
        expect(onPress).toHaveBeenCalledTimes(0);
    });

    it('treats two quick presses as a double press on web', async () => {
        const onPress = vi.fn();
        const onDoublePress = vi.fn();
        const { Item } = await import('./Item');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Item
                    title="Hello"
                    onPress={onPress}
                    onDoublePress={onDoublePress}
                    showChevron={false}
                />
            );
        });

        const pressable = (tree! as any).root.findByType('Pressable');
        expect(typeof pressable.props.onPress).toBe('function');

        vi.useFakeTimers();
        vi.setSystemTime(0);

        await act(async () => {
            pressable.props.onPress({ nativeEvent: { detail: 1 } });
        });

        expect(onPress).toHaveBeenCalledTimes(1);
        expect(onDoublePress).toHaveBeenCalledTimes(0);

        vi.setSystemTime(120);

        await act(async () => {
            pressable.props.onPress({ nativeEvent: { detail: 1 } });
        });

        expect(onPress).toHaveBeenCalledTimes(1);
        expect(onDoublePress).toHaveBeenCalledTimes(1);

        vi.useRealTimers();
    });

    it('does not fire onPress immediately after onDoubleClick on web', async () => {
        const onPress = vi.fn();
        const onDoublePress = vi.fn();
        const { Item } = await import('./Item');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Item
                    title="Hello"
                    onPress={onPress}
                    onDoublePress={onDoublePress}
                    showChevron={false}
                />
            );
        });

        const pressable = (tree! as any).root.findByType('Pressable');
        expect(typeof pressable.props.onDoubleClick).toBe('function');
        expect(typeof pressable.props.onPress).toBe('function');

        vi.useFakeTimers();
        vi.setSystemTime(1000);

        await act(async () => {
            pressable.props.onDoubleClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
        });

        // Some RN web builds dispatch an onPress after onDoubleClick; ensure we ignore it so a pinned-open
        // is not immediately overwritten by a preview-open.
        vi.setSystemTime(1100);
        await act(async () => {
            pressable.props.onPress({ nativeEvent: { detail: 1 }, preventDefault: vi.fn(), stopPropagation: vi.fn() });
        });

        expect(onDoublePress).toHaveBeenCalledTimes(1);
        expect(onPress).toHaveBeenCalledTimes(0);

        vi.useRealTimers();
    });

    it('treats web click detail=1 as a single press', async () => {
        const onPress = vi.fn();
        const onDoublePress = vi.fn();
        const { Item } = await import('./Item');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Item
                    title="Hello"
                    onPress={onPress}
                    onDoublePress={onDoublePress}
                    showChevron={false}
                />
            );
        });

        const pressable = (tree! as any).root.findByType('Pressable');

        await act(async () => {
            pressable.props.onPress({ nativeEvent: { detail: 1 } });
        });

        expect(onPress).toHaveBeenCalledTimes(1);
        expect(onDoublePress).toHaveBeenCalledTimes(0);
    });
});
