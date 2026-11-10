import { useCallback, useMemo, useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import type { SelectableMenuCategory, SelectableMenuItem, SelectableMenuItemSource } from './selectableMenuTypes';
import { t } from '@/text';
import {
    matchesHappierMenuQuery,
    useHappierMenuInteraction,
} from '@happier-dev/plugin-ui/presentation';

/**
 * Items that name no category form one untitled group: a menu never invents a heading ("General",
 * "Results") the caller did not write.
 */
function groupByCategory(
    items: ReadonlyArray<SelectableMenuItem>,
    /** When given, only the groups named here are titled; every other key still keeps its own section. */
    titles?: Readonly<Record<string, string>>,
): SelectableMenuCategory[] {
    const grouped = items.reduce((acc, item) => {
        const category = item.category || '';
        if (!acc[category]) acc[category] = [];
        acc[category]!.push(item);
        return acc;
    }, {} as Record<string, SelectableMenuItem[]>);

    return Object.entries(grouped).map(([title, groupedItems]) => ({
        // The title is the grouping key above, so it is also the section's identity: no two sections can share a React key.
        id: title || '__uncategorized__',
        title: titles ? titles[title] ?? '' : title,
        items: groupedItems,
    }));
}

export const CREATE_ITEM_ID = '__create__';

export function useSelectableMenu(params: {
    items: ReadonlyArray<SelectableMenuItem>;
    itemSource?: SelectableMenuItemSource;
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
    onKeyboardSelectionChange?: (index: number) => void;
    /** Clears transient prefix navigation state while the controlled menu is closed. */
    open?: boolean;
    /** Titles for the named category keys; other categories stay untitled sections. */
    categoryTitles?: Readonly<Record<string, string>>;
}) {
    const [searchQuery, setSearchQuery] = useState('');
    const inputRef = useRef<TextInput>(null);

    const allItemsRaw = useMemo(() => params.items, [params.items]);

    const filteredCategories = useMemo((): SelectableMenuCategory[] => {
        const query = searchQuery.trim().toLowerCase();

        if (!query) {
            return groupByCategory(allItemsRaw, params.categoryTitles);
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
        return groupByCategory(filtered, params.categoryTitles);
    }, [allItemsRaw, params.categoryTitles, params.createItemFactory, params.onCreateItem, searchQuery]);

    const { allItems, itemIndexById } = useMemo(() => {
        const allItems = filteredCategories.flatMap((c) => c.items);
        // A source's unfiltered order is already indexed. A query owns only its matching rows.
        const itemIndexById = params.itemSource
            ? new Map(allItems.map((item, index) => [item.id, index]))
            : undefined;
        return { allItems, itemIndexById };
    }, [filteredCategories, params.itemSource?.indexById, searchQuery]);
    const getItemLabel = useCallback((item: SelectableMenuItem) => item.title, []);
    // A run of swatches is one keyboard row: Left/Right move along it, Up/Down step past it.
    const getItemRowGroup = useCallback((item: SelectableMenuItem) => (item.swatch ? `swatch:${item.swatch.group ?? ''}` : null), []);
    const {
        selectedIndex,
        setSelectedIndex,
        handleKeyPress,
    } = useHappierMenuInteraction({
        items: allItems,
        itemIndexById,
        open: params.open,
        initialSelectedId: params.initialSelectedId,
        allowEmptySelection: params.allowEmptySelection,
        enableTypeahead: params.enableTypeahead,
        onKeyboardSelectionChange: params.onKeyboardSelectionChange,
        // Filtering is this adapter's concern; the portable owner performs the reset. Only a new query resets the
        // highlight: rows that arrive or change while the menu is open (discovered models, a spinner) keep the
        // highlighted row, so the list never jumps back to the selection under the pointer.
        resetKey: searchQuery,
        onRequestClose: params.onRequestClose,
        getItemLabel,
        getItemRowGroup,
    });

    const handleSearchChange = useCallback((text: string) => setSearchQuery(text), []);

    return {
        searchQuery,
        selectedIndex,
        filteredCategories,
        allItems,
        inputRef,
        handleSearchChange,
        handleKeyPress,
        setSelectedIndex,
        itemSource: params.itemSource,
    };
}
