import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';


// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('ItemGroupTitleWithAction', () => {
    it('renders the action button immediately after the title', async () => {
        const { ItemGroupTitleWithAction } = await import('./ItemGroupTitleWithAction');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(React.createElement(ItemGroupTitleWithAction, {
                title: 'Detected CLIs',
                titleStyle: { color: '#000' },
                action: {
                    accessibilityLabel: 'Refresh',
                    iconName: 'refresh',
                    iconColor: '#666',
                    onPress: vi.fn(),
                },
            }))).tree;

        const rootView = tree!.findByType('View' as any);
        const children = React.Children.toArray(rootView.props.children) as any[];
        expect(children).toHaveLength(2);
        expect(children[1]?.type).toBe('Pressable');

        const titleNodes = tree!.findAllByType('Text' as any).filter((node) => {
            const value = node.props.children;
            return Array.isArray(value) ? value.join('') === 'Detected CLIs' : value === 'Detected CLIs';
        });
        expect(titleNodes.length).toBeGreaterThan(0);
    });

    it('renders title only when no action is provided', async () => {
        const { ItemGroupTitleWithAction } = await import('./ItemGroupTitleWithAction');

        const screen = await renderScreen(React.createElement(ItemGroupTitleWithAction, {
                title: 'Detected CLIs',
                titleStyle: { color: '#000' },
            }));

        expect(screen.findAllByProps({ accessibilityRole: 'button' }).length).toBe(0);
        expect(screen.findAllByType('Text' as any).length).toBe(1);
    });

    it('renders loading indicator instead of icon when action is loading', async () => {
        const { ItemGroupTitleWithAction } = await import('./ItemGroupTitleWithAction');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(React.createElement(ItemGroupTitleWithAction, {
                title: 'Detected CLIs',
                action: {
                    accessibilityLabel: 'Refresh',
                    iconName: 'refresh',
                    iconColor: '#666',
                    loading: true,
                    onPress: vi.fn(),
                },
            }))).tree;

        expect(tree!.findAllByType('ActivityIndicator' as any).length).toBe(1);
        expect(tree!.findAllByType('Ionicons' as any).length).toBe(0);
    });
});
