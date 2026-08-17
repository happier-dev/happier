import { useCallback, useMemo, useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import type { SelectableMenuCategory, SelectableMenuItem } from './selectableMenuTypes';
import { t } from '@/text';
import {
    matchesHappierMenuQuery,
    useHappierMenuInteraction,
} from '@happier-dev/plugin-ui/presentation';

function toCategoryId(title: string): string {
    return title.toLowerCase().replace(/\s+/g, '-');
}

function groupByCategory(items: ReadonlyArray<SelectableMenuItem>, defaultCategory: string): SelectableMenuCategory[] {
    const grouped = items.reduce((acc, item) => {
        const category = item.category || defaultCategory;
        if (!acc[category]) acc[category] = [];
        acc[category]!.push(item);
        return acc;
    }, {} as Record<string, SelectableMenuItem[]>);

    return Object.entries(grouped).map(([title, groupedItems]) => ({
        id: toCategoryId(title),
        title,
        items: groupedItems,
    }));
}

export const CREATE_ITEM_ID = '__create__';

export function useSelectableMenu(params: {
    items: ReadonlyArray<SelectableMenuItem>;
    onRequestClose: () => void;
    initialSelectedId?: string | null;
    onCreateItem?: ((query: string) => void) | null;
    createItemFactory?: ((query: string) => Omit<SelectableMenuItem, 'id'>) | null;
    /**
     * When true, the menu can start with no highlighted item (`selectedIndex = -1`).
     * This is useful for touch-first context menus on native where an initial highlight
     * reads as a "selected" row even before the user interacts.
     */
    allowEmptySelection?: boolean;
    /** Use shared prefix navigation when no search input owns typed text. */
    enableTypeahead?: boolean;
    /** Clears transient prefix navigation state while the controlled menu is closed. */
    open?: boolean;
}) {
    const [searchQuery, setSearchQuery] = useState('');
    const inputRef = useRef<TextInput>(null);

    const allItemsRaw = useMemo(() => params.items, [params.items]);
    const defaultCategoryTitle = t('dropdown.category.general');
    const resultsCategoryTitle = t('dropdown.category.results');

    const filteredCategories = useMemo((): SelectableMenuCategory[] => {
        const query = searchQuery.trim().toLowerCase();

        if (!query) {
            return groupByCategory(allItemsRaw, defaultCategoryTitle);
        }

        const filtered = allItemsRaw.filter((item) => {
            return matchesHappierMenuQuery({
                label: item.title,
                description: item.subtitle,
                query,
            });
        });

        if (filtered.length === 0) {
            if (params.onCreateItem) {
                const queryText = searchQuery.trim();
                const createItem = params.createItemFactory
                    ? params.createItemFactory(queryText)
                    : { title: `${t('dropdown.createItem.prefix')} "${queryText}"` };
                return [{
                    id: '__create_category__',
                    title: '',
                    items: [{ id: CREATE_ITEM_ID, ...createItem }],
                }];
            }
            return [];
        }
        return groupByCategory(filtered, resultsCategoryTitle);
    }, [allItemsRaw, defaultCategoryTitle, params.createItemFactory, params.onCreateItem, resultsCategoryTitle, searchQuery]);

    const allItems = useMemo(() => {
        return filteredCategories.flatMap((c) => c.items);
    }, [filteredCategories]);
    const getItemLabel = useCallback((item: SelectableMenuItem) => item.title, []);
    const {
        selectedIndex,
        setSelectedIndex,
        handleKeyPress,
    } = useHappierMenuInteraction({
        items: allItems,
        open: params.open,
        initialSelectedId: params.initialSelectedId,
        allowEmptySelection: params.allowEmptySelection,
        enableTypeahead: params.enableTypeahead,
        // Filtering is this adapter's concern; the portable owner performs the reset.
        resetKey: allItems,
        onRequestClose: params.onRequestClose,
        getItemLabel,
    });

    const handleSearchChange = useCallback((text: string) => setSearchQuery(text), []);

    return {
        searchQuery,
        selectedIndex,
        filteredCategories,
        inputRef,
        handleSearchChange,
        handleKeyPress,
        setSelectedIndex,
    };
}
