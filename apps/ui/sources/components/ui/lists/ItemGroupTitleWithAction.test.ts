import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => await import('@/dev/reactNativeStub'));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('ItemGroupTitleWithAction', () => {
    it('renders the action button immediately after the title', async () => {
        const { ItemGroupTitleWithAction } = await import('./ItemGroupTitleWithAction');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(React.createElement(ItemGroupTitleWithAction, {
                title: 'Detected CLIs',
                titleStyle: { color: '#000' },
                action: {
                    accessibilityLabel: 'Refresh',
                    iconName: 'refresh',
                    iconColor: '#666',
                    onPress: vi.fn(),
                },
            }));
        });

        const rootView = tree!.root.findByType('View' as any);
        const children = React.Children.toArray(rootView.props.children) as any[];
        expect(children).toHaveLength(2);
        expect(children[1]?.type).toBe('Pressable');

        const titleNodes = tree!.root.findAllByType('Text' as any).filter((node) => {
            const value = node.props.children;
            return Array.isArray(value) ? value.join('') === 'Detected CLIs' : value === 'Detected CLIs';
        });
        expect(titleNodes.length).toBeGreaterThan(0);
    });

    it('renders title only when no action is provided', async () => {
        const { ItemGroupTitleWithAction } = await import('./ItemGroupTitleWithAction');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(React.createElement(ItemGroupTitleWithAction, {
                title: 'Detected CLIs',
                titleStyle: { color: '#000' },
            }));
        });

        expect(tree!.root.findAllByType('Pressable' as any).length).toBe(0);
        expect(tree!.root.findAllByType('Text' as any).length).toBe(1);
    });

    it('renders loading indicator instead of icon when action is loading', async () => {
        const { ItemGroupTitleWithAction } = await import('./ItemGroupTitleWithAction');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(React.createElement(ItemGroupTitleWithAction, {
                title: 'Detected CLIs',
                action: {
                    accessibilityLabel: 'Refresh',
                    iconName: 'refresh',
                    iconColor: '#666',
                    loading: true,
                    onPress: vi.fn(),
                },
            }));
        });

        expect(tree!.root.findAllByType('ActivityIndicator' as any).length).toBe(1);
        expect(tree!.root.findAllByType('Ionicons' as any).length).toBe(0);
    });
});
