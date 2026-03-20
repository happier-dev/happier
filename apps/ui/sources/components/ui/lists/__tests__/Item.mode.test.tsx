import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let uiItemDensitySetting: 'comfortable' | 'cozy' | 'compact' = 'comfortable';

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        Platform: { ...(actual.Platform ?? {}), OS: 'web' },
        View: 'View',
        Text: 'Text',
        ActivityIndicator: 'ActivityIndicator',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    };
});

vi.mock('react-native-unistyles', () => {
    const theme = {
        dark: false,
        colors: {
            text: '#000',
            textSecondary: '#666',
            textDestructive: '#f00',
            surface: '#fff',
            surfaceHigh: '#f5f5f5',
            surfaceHighest: '#eee',
            surfacePressedOverlay: 'rgba(0,0,0,0.1)',
            surfaceRipple: 'rgba(0,0,0,0.1)',
            surfaceSelected: '#e0e0ff',
            divider: '#e0e0e0',
            groupped: { chevron: '#999' },
            shadow: { color: '#000', opacity: 0.2 },
        },
    };
    return {
        useUnistyles: () => ({ theme }),
        StyleSheet: { create: (input: any) => (typeof input === 'function' ? input(theme, {}) : input) },
    };
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => 'middle',
}));

vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => ({}),
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: any) => node,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('@/text', () => ({ t: (key: string) => key }));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'uiItemDensity') return uiItemDensitySetting;
        if (key === 'uiFontScale') return 1;
        return null;
    },
}));

describe('Item mode prop', () => {
    beforeEach(() => {
        vi.resetModules();
        uiItemDensitySetting = 'comfortable';
    });

    it('renders a Pressable when mode is undefined and onPress is set', async () => {
        const { Item } = await import('../Item');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Item title="Test" onPress={() => {}} />);
        });
        const pressables = tree.root.findAllByType('Pressable' as any);
        expect(pressables.length).toBeGreaterThan(0);
    });

    it('renders a View (not Pressable) when mode="info" even with onPress', async () => {
        const { Item } = await import('../Item');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Item title="Info Item" mode="info" onPress={() => {}} />);
        });
        const pressables = tree.root.findAllByType('Pressable' as any);
        expect(pressables).toHaveLength(0);
    });

    it('never shows chevron when mode="info" regardless of showChevron prop', async () => {
        const { Item } = await import('../Item');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Item title="Info" mode="info" showChevron={true} onPress={() => {}} />,
            );
        });
        const json = tree.toJSON();
        const findChevron = (node: any): boolean => {
            if (!node) return false;
            if (node.props?.name === 'chevron-forward') return true;
            if (Array.isArray(node.children)) return node.children.some(findChevron);
            if (Array.isArray(node)) return node.some(findChevron);
            return false;
        };
        expect(findChevron(json)).toBe(false);
    });

    it('does NOT reduce opacity when mode="info" (unlike disabled)', async () => {
        const { Item } = await import('../Item');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Item title="Info" mode="info" />);
        });
        // mode="info" renders a plain View (non-interactive path)
        const root = tree.root.findByType('View' as any);
        const style = root.props.style;
        const flattened = Array.isArray(style)
            ? style.reduce(
                  (acc: Record<string, unknown>, next: Record<string, unknown> | null | undefined) => ({
                      ...acc,
                      ...(next ?? {}),
                  }),
                  {},
              )
            : (style ?? {});
        // opacity should be 1 (not 0.5 like disabled)
        expect(flattened.opacity).not.toBe(0.5);
    });

    it('reduces opacity when disabled (not mode="info")', async () => {
        const { Item } = await import('../Item');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Item title="Disabled" disabled={true} />);
        });
        const root = tree.root.findByType('View' as any);
        const style = root.props.style;
        const flattened = Array.isArray(style)
            ? style.reduce(
                  (acc: Record<string, unknown>, next: Record<string, unknown> | null | undefined) => ({
                      ...acc,
                      ...(next ?? {}),
                  }),
                  {},
              )
            : (style ?? {});
        expect(flattened.opacity).toBe(0.5);
    });

    it('renders a Pressable when mode="interactive" with onPress', async () => {
        const { Item } = await import('../Item');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Item title="Interactive" mode="interactive" onPress={() => {}} />);
        });
        const pressables = tree.root.findAllByType('Pressable' as any);
        expect(pressables.length).toBeGreaterThan(0);
    });

    it('uses the middle global item density when density prop is omitted', async () => {
        uiItemDensitySetting = 'cozy';
        const { Item } = await import('../Item');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Item title="Compact by setting" subtitle="Subtitle" />);
        });

        const titleNode = tree.root.findAllByType('Text' as any).find((node: any) => node.props?.children === 'Compact by setting');
        expect(titleNode?.props?.style).toEqual(expect.arrayContaining([expect.objectContaining({ fontSize: 14, lineHeight: 20 })]));
        uiItemDensitySetting = 'comfortable';
    });

    it('preserves an explicit density prop over the global item density', async () => {
        uiItemDensitySetting = 'compact';
        const { Item } = await import('../Item');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Item title="Explicit density" subtitle="Subtitle" density="comfortable" />);
        });

        const titleNode = tree.root.findAllByType('Text' as any).find((node: any) => node.props?.children === 'Explicit density');
        expect(titleNode?.props?.style).not.toEqual(expect.arrayContaining([expect.objectContaining({ fontSize: 13, lineHeight: 18 })]));
        uiItemDensitySetting = 'comfortable';
    });

    it('applies the resolved density to right-side detail text', async () => {
        uiItemDensitySetting = 'compact';
        const { Item } = await import('../Item');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Item title="Detail row" detail="Compact detail" />);
        });

        const detailNode = tree.root.findAllByType('Text' as any).find((node: any) => node.props?.children === 'Compact detail');
        expect(detailNode?.props?.style).toEqual(expect.arrayContaining([expect.objectContaining({ fontSize: 13, lineHeight: 18 })]));
        uiItemDensitySetting = 'comfortable';
    });

    it('forces icon prop size to the resolved density size', async () => {
        uiItemDensitySetting = 'cozy';
        const { Item } = await import('../Item');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Item
                    title="Density icon"
                    icon={React.createElement('Ionicons', { name: 'albums-outline', size: 29, color: '#09f' })}
                />,
            );
        });

        const leftIcon = tree.root.findAllByType('Ionicons' as any).find((node: any) => node.props?.name === 'albums-outline');
        expect(leftIcon?.props?.size).toBe(24);
        uiItemDensitySetting = 'comfortable';
    });

    it('forces chevron size to the resolved density size', async () => {
        uiItemDensitySetting = 'compact';
        const { Item } = await import('../Item');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Item title="Chevron row" onPress={() => {}} />);
        });

        const chevronIcon = tree.root.findAllByType('Ionicons' as any).find((node: any) => node.props?.name === 'chevron-forward');
        expect(chevronIcon?.props?.size).toBe(15);
        uiItemDensitySetting = 'comfortable';
    });
});
