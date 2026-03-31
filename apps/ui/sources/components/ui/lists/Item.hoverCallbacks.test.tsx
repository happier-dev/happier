import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

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

describe('Item hover callbacks', () => {
    it('invokes onHoverIn/onHoverOut when hovered on web', async () => {
        const onHoverIn = vi.fn();
        const onHoverOut = vi.fn();
        const { Item } = await import('./Item');
        const ItemAny = Item as any;

        const screen = await renderScreen(
            <ItemAny
                testID="item-hover-callbacks"
                title="Hover"
                onPress={() => {}}
                onHoverIn={onHoverIn}
                onHoverOut={onHoverOut}
            />,
        );

        const row = screen.findByTestId('item-hover-callbacks') as any;
        expect(typeof row.props.onHoverIn).toBe('function');
        expect(typeof row.props.onHoverOut).toBe('function');

        await act(async () => {
            row.props.onHoverIn();
        });
        expect(onHoverIn).toHaveBeenCalledTimes(1);

        await act(async () => {
            row.props.onHoverOut();
        });
        expect(onHoverOut).toHaveBeenCalledTimes(1);
    });
});
