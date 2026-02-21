import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { SearchableListSelector } from './SearchableListSelector';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: {
        OS: 'web',
        select: (spec: { web?: unknown; ios?: unknown; default?: unknown }) =>
            (spec && 'web' in spec ? spec.web : spec?.default),
    },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        rt: { themeName: 'light' },
        theme: {
            dark: false,
            colors: {
                surface: '#fff',
                divider: '#ddd',
                shadow: { color: '#000', opacity: 0.2 },
                textSecondary: '#666',
                textLink: '#00f',
                button: { primary: { background: '#00f' } },
            },
        },
    }),
    StyleSheet: { create: () => ({}) },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: () => null,
}));

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: () => null,
}));

describe('SearchableListSelector (disabled items)', () => {
    it('marks disabled rows and prevents selection when pressed', async () => {
        const onSelect = vi.fn();

        const items = [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
        ] as const;

        const config: any = {
            getItemId: (item: any) => item.id,
            getItemTitle: (item: any) => item.title,
            getItemIcon: () => null,
            formatForDisplay: (item: any) => item.title,
            parseFromDisplay: () => null,
            filterItem: () => true,
            searchPlaceholder: 'Search…',
            recentSectionTitle: 'Recent',
            favoritesSectionTitle: 'Favorites',
            allSectionTitle: 'All',
            noItemsMessage: 'Empty',
            showFavorites: false,
            showRecent: false,
            showSearch: false,
            allowCustomInput: false,
            isItemDisabled: (item: any) => item.id === 'b',
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SearchableListSelector
                    config={config}
                    items={[...items] as any}
                    selectedItem={null}
                    onSelect={onSelect}
                />,
            );
        });

        const renderedItems = tree!.root.findAllByType('Item');
        const rowA = renderedItems.find((n) => n.props.title === 'A');
        const rowB = renderedItems.find((n) => n.props.title === 'B');
        expect(rowA).toBeTruthy();
        expect(rowB).toBeTruthy();

        expect(rowA!.props.disabled).toBeFalsy();
        expect(rowB!.props.disabled).toBe(true);

        rowB!.props.onPress?.();
        expect(onSelect).not.toHaveBeenCalled();

        rowA!.props.onPress?.();
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith(items[0]);
    });
});
