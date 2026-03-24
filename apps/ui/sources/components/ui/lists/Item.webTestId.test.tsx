import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
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
