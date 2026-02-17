import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
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
    StyleSheet: { create: (fn: any) => fn({ colors: { groupped: { background: '#111', chevron: '#888' }, divider: '#444' } }, {}) },
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

describe('Item', () => {
  it('wraps primitive children when subtitle is a ReactNode', async () => {
        const { Item } = await import('./Item');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Item
                    title="Title"
                    // Historically this shape can accidentally introduce raw text nodes into a <View>.
                    subtitle={<>{'.'}</>}
                    showChevron={false}
                />
            );
        });

        const json = (tree! as any).toJSON();

        const seen: { dotCount: number; badDotCount: number; badParents: Array<string | null> } = {
            dotCount: 0,
            badDotCount: 0,
            badParents: [],
        };
        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string') {
                if (node === '.') {
                    seen.dotCount += 1;
                    if (parentType !== 'Text') {
                        seen.badDotCount += 1;
                        seen.badParents.push(parentType);
                    }
                }
                return;
            }
            const nextParent = typeof node.type === 'string' ? node.type : null;
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) walk(child, nextParent);
        };

        walk(json, null);

        expect(seen.dotCount).toBeGreaterThan(0);
        expect({ badDotCount: seen.badDotCount, badParents: seen.badParents }).toEqual({
            badDotCount: 0,
            badParents: [],
        });
    });

    it('uses a not-allowed cursor on web when disabled', async () => {
        const { Item } = await import('./Item');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Item title="Title" onPress={() => {}} disabled showChevron={false} />,
            );
        });

        const pressable = (tree! as any).root.findByType('Pressable' as any);
        const styleFn = pressable.props.style;
        expect(typeof styleFn).toBe('function');

        const resolved = styleFn({ pressed: false });
        const styles = Array.isArray(resolved) ? resolved : [resolved];
        expect(styles.some((s: any) => s && typeof s === 'object' && s.cursor === 'not-allowed')).toBe(true);
    });
});
