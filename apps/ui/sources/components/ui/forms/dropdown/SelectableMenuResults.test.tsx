import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { ...stub.Platform, OS: 'web' },
    };
});

vi.mock('@/components/ui/lists/SelectableRow', () => ({
    SelectableRow: (props: any) => {
        const React = require('react');
        return React.createElement('SelectableRow', props);
    },
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => {
        const React = require('react');
        return React.createElement('Item', props);
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: {
        Provider: ({ children }: any) => children,
    },
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    ItemGroupRowPositionBoundary: ({ children }: any) => children,
}));

describe('SelectableMenuResults', () => {
    it('omits the category title row when the category title is empty', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SelectableMenuResults
                    categories={[
                        { id: 'c1', title: '', items: [{ id: 'a', title: 'A' }] },
                    ]}
                    selectedIndex={0}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                    emptyLabel="Empty"
                />,
            );
        });

        expect(tree).not.toBeNull();
        const textNodes = (tree as any).root.findAllByType('Text');
        expect(textNodes.length).toBe(0);
    });

    it('renders nothing for empty results when emptyLabel is null', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SelectableMenuResults
                    categories={[]}
                    selectedIndex={0}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                    emptyLabel={null as any}
                />,
            );
        });

        expect(tree).not.toBeNull();
        expect((tree as any).toJSON()).toBe(null);
    });
});
