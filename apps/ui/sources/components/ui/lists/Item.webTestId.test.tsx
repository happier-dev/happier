import React from 'react';
import renderer from 'react-test-renderer';
import { Pressable } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

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
    function findClosestPressableAncestor(node: renderer.ReactTestInstance): renderer.ReactTestInstance | null {
        let current = node.parent;
        while (current) {
            if (String(current.type) === 'Pressable') {
                return current;
            }
            current = current.parent;
        }
        return null;
    }

    it('forwards testID as data-testid on interactive web rows', async () => {
        const { Item } = await import('./Item');
        const screen = await renderScreen(<Item
                    testID="settings-appearance-themePreference-cycle"
                    title="Appearance"
                    detail="Adaptive"
                    onPress={() => {}}
                />);

        const row = screen.findByTestId('settings-appearance-themePreference-cycle');
        expect(row).toBeTruthy();
        expect(row?.props.testID).toBe('settings-appearance-themePreference-cycle');
        expect(row?.props['data-testid']).toBe('settings-appearance-themePreference-cycle');
        expect(row?.props.accessibilityRole).toBe('button');
    });

    it('allows right-side actions inside a non-button web row role', async () => {
        const { Item } = await import('./Item');
        const screen = await renderScreen(
            <Item
                testID="item-with-actions"
                title="Relay"
                onPress={() => {}}
                webRole="treeitem"
                rightElement={(
                    <Pressable testID="item-right-action" onPress={() => {}}>
                        <Text>Action</Text>
                    </Pressable>
                )}
            />,
        );

        const row = screen.findByTestId('item-with-actions');
        const action = screen.findByTestId('item-right-action');

        expect(row?.props.role).toBe('treeitem');
        expect(findClosestPressableAncestor(action as renderer.ReactTestInstance)).toBe(row);
    });

    it('forwards testID as data-testid on non-interactive web rows', async () => {
        const { Item } = await import('./Item');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<Item
                    testID="settings-static-row"
                    title="Static"
                    mode="info"
                />)).tree;

        const view = tree.findByType('View' as any);
        expect(view.props.testID).toBe('settings-static-row');
        expect(view.props['data-testid']).toBe('settings-static-row');
    });
});
