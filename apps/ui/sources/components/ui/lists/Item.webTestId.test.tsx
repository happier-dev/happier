import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        Platform: { ...(actual.Platform ?? {}), OS: 'web' },
        View: (props: any) => React.createElement('View', props, props.children),
        Text: 'Text',
        ActivityIndicator: 'ActivityIndicator',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    };
});

vi.mock('react-native-unistyles', () => {
    const theme = {
        dark: false,
        colors: {
            text: '#111',
            textSecondary: '#777',
            textDestructive: '#b00',
            divider: '#ddd',
            surfacePressedOverlay: '#eee',
            surfaceSelected: '#ddd',
            surfaceRipple: '#ccc',
            groupped: {
                chevron: '#888',
            },
            shadow: { color: '#000', opacity: 0.2 },
        },
    };
    return {
        useUnistyles: () => ({ theme }),
        StyleSheet: { create: (input: any) => (typeof input === 'function' ? input(theme) : input) },
    };
});

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: unknown) => node,
}));

vi.mock('@/components/ui/lists/useResolvedItemDensity', () => ({
    useResolvedItemDensity: () => 'comfortable',
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => null,
}));

vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => null,
}));

describe('Item web testID forwarding', () => {
    it('forwards testID as data-testid on interactive web rows', async () => {
        const { Item } = await import('./Item');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Item
                    testID="settings-appearance-themePreference-cycle"
                    title="Appearance"
                    detail="Adaptive"
                    onPress={() => {}}
                />,
            );
        });

        const pressable = tree.root.findByType('Pressable' as any);
        expect(pressable.props.testID).toBe('settings-appearance-themePreference-cycle');
        expect(pressable.props['data-testid']).toBe('settings-appearance-themePreference-cycle');
        expect(pressable.props.accessibilityRole).toBe('button');
    });

    it('forwards testID as data-testid on non-interactive web rows', async () => {
        const { Item } = await import('./Item');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Item
                    testID="settings-static-row"
                    title="Static"
                    mode="info"
                />,
            );
        });

        const view = tree.root.findByType('View' as any);
        expect(view.props.testID).toBe('settings-static-row');
        expect(view.props['data-testid']).toBe('settings-static-row');
    });
});
