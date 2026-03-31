import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { View } from 'react-native';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: unknown) => node,
}));

vi.mock('@/components/ui/lists/useResolvedItemDensity', () => ({
    useResolvedItemDensity: () => 'compact',
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

describe('Item leftElementWhenHovered', () => {
    it('swaps left element while hovered on web', async () => {
        const { Item } = await import('./Item');
        const ItemAny = Item as any;
        const screen = await renderScreen(
            <ItemAny
                testID="item-left-hover"
                title="Hover"
                onPress={() => {}}
                leftElement={<View testID="default-left" />}
                leftElementWhenHovered={<View testID="hover-left" />}
            />,
        );

        expect(screen.findByTestId('default-left')).toBeTruthy();
        expect(screen.findByTestId('hover-left')).toBeNull();

        const row = screen.findByTestId('item-left-hover') as any;
        await act(async () => {
            row.props.onHoverIn();
        });

        expect(screen.findByTestId('default-left')).toBeNull();
        expect(screen.findByTestId('hover-left')).toBeTruthy();
    });
});
