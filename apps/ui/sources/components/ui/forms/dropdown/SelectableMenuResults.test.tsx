import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installDropdownCommonModuleMocks } from './dropdownTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installDropdownCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        });
    },
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

        const screen = await renderScreen(<SelectableMenuResults
                    categories={[
                        { id: 'c1', title: '', items: [{ id: 'a', title: 'A' }] },
                    ]}
                    selectedIndex={0}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                    emptyLabel="Empty"
                />);

        expect(screen.tree).not.toBeNull();
        expect(screen.findAllByType('Text')).toHaveLength(0);
    });

    it('renders nothing for empty results when emptyLabel is null', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const screen = await renderScreen(<SelectableMenuResults
                    categories={[]}
                    selectedIndex={0}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                    emptyLabel={null as any}
                />);

        expect(screen.tree).not.toBeNull();
        expect(screen.tree.toJSON()).toBe(null);
    });

    it('forwards compact item props to item rows', async () => {
        const { SelectableMenuResults } = await import('./SelectableMenuResults');

        const screen = await renderScreen(<SelectableMenuResults
                    categories={[
                        { id: 'c1', title: '', items: [{ id: 'a', title: 'Alpha', subtitle: 'Selected subtitle' }] },
                    ]}
                    selectedIndex={0}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                    rowKind="item"
                    itemProps={{ density: 'compact' }}
                />);

        const item = screen.findByType('Item');
        expect(item.props.density).toBe('compact');
        expect(item.props.subtitle).toBe('Selected subtitle');
    });
});
