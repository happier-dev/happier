import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import type { SelectableMenuCategory, SelectableMenuItem } from './selectableMenuTypes';
import { t } from '@/text';

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
}) {
    const [searchQuery, setSearchQuery] = useState('');
    const allowEmptySelection = params.allowEmptySelection === true;
    const [selectedIndex, setSelectedIndex] = useState<number>(() => (allowEmptySelection ? -1 : 0));
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
            const titleMatch = item.title.toLowerCase().includes(query);
            const subtitleMatch = item.subtitle?.toLowerCase().includes(query) ?? false;
            return titleMatch || subtitleMatch;
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

    const firstEnabledIndex = useCallback((): number => {
        for (let i = 0; i < allItems.length; i += 1) {
            if (!allItems[i]?.disabled) return i;
        }
        return allowEmptySelection ? -1 : 0;
    }, [allItems, allowEmptySelection]);

    const lastEnabledIndex = useCallback((): number => {
        for (let i = allItems.length - 1; i >= 0; i -= 1) {
            if (!allItems[i]?.disabled) return i;
        }
        return allowEmptySelection ? -1 : 0;
    }, [allItems, allowEmptySelection]);

    const isEnabledIndex = useCallback((idx: number) => {
        const item = allItems[idx];
        return Boolean(item && !item.disabled);
    }, [allItems]);

    const clampToEnabled = useCallback((idx: number): number => {
        if (allowEmptySelection && idx === -1) return -1;
        if (allItems.length === 0) return allowEmptySelection ? -1 : 0;
        if (idx < 0 || idx >= allItems.length) return firstEnabledIndex();
        if (isEnabledIndex(idx)) return idx;
        return firstEnabledIndex();
    }, [allItems.length, allowEmptySelection, firstEnabledIndex, isEnabledIndex]);

    // Initialize / reset selection when the query or available items change.
    useEffect(() => {
        const preferredId = params.initialSelectedId ?? null;
        if (preferredId) {
            const idx = allItems.findIndex((i) => i.id === preferredId);
            if (idx >= 0 && isEnabledIndex(idx)) {
                setSelectedIndex(idx);
                return;
            }
        }
        setSelectedIndex(allowEmptySelection ? -1 : firstEnabledIndex());
    }, [allItems, allowEmptySelection, firstEnabledIndex, isEnabledIndex, params.initialSelectedId, searchQuery]);

    const moveSelection = useCallback((dir: -1 | 1, from: number = selectedIndex) => {
        if (allItems.length === 0) return;
        if (allowEmptySelection && from === -1) {
            setSelectedIndex(dir === 1 ? firstEnabledIndex() : lastEnabledIndex());
            return;
        }
        let next = from;
        for (let step = 0; step < allItems.length; step += 1) {
            next = Math.min(allItems.length - 1, Math.max(0, next + dir));
            if (isEnabledIndex(next)) {
                setSelectedIndex(next);
                return;
            }
        }
    }, [allItems.length, allowEmptySelection, firstEnabledIndex, isEnabledIndex, lastEnabledIndex, selectedIndex]);

    /** A run of consecutive swatches in one group renders as one row; returns its index bounds. */
    const swatchRunAt = useCallback((idx: number): Readonly<{ start: number; end: number }> | null => {
        const group = allItems[idx]?.swatch?.group ?? null;
        if (!allItems[idx]?.swatch) return null;
        const sameRow = (i: number) => Boolean(allItems[i]?.swatch) && (allItems[i]!.swatch!.group ?? null) === group;
        let start = idx;
        let end = idx;
        while (sameRow(start - 1)) start -= 1;
        while (sameRow(end + 1)) end += 1;
        return { start, end };
    }, [allItems]);

    /** Up/Down step between rows: a swatch row counts as one row and is entered at its start. */
    const moveRow = useCallback((dir: -1 | 1) => {
        const run = selectedIndex >= 0 ? swatchRunAt(selectedIndex) : null;
        const from = run ? (dir === 1 ? run.end : run.start) : selectedIndex;
        const before = from + dir;
        const targetRun = swatchRunAt(before);
        if (dir === -1 && targetRun && isEnabledIndex(targetRun.start)) {
            setSelectedIndex(targetRun.start);
            return;
        }
        moveSelection(dir, from);
    }, [isEnabledIndex, moveSelection, selectedIndex, swatchRunAt]);

    const handleKeyPress = useCallback((
        key: string,
        onActivate: (item: SelectableMenuItem) => void,
        nav?: Readonly<{
            /** Opens the highlighted item's submenu (ArrowRight / Enter). */
            onOpenSubmenu?: (item: SelectableMenuItem) => void;
            /** Returns from a submenu to its parent (ArrowLeft outside a swatch row). */
            onBack?: () => void;
        }>,
    ) => {
        const current = selectedIndex >= 0 && isEnabledIndex(selectedIndex) ? allItems[selectedIndex] ?? null : null;
        const run = selectedIndex >= 0 ? swatchRunAt(selectedIndex) : null;
        switch (key) {
            case 'Escape':
                params.onRequestClose();
                break;
            case 'ArrowDown':
                moveRow(1);
                break;
            case 'ArrowUp':
                moveRow(-1);
                break;
            case 'ArrowRight':
                if (run) {
                    if (selectedIndex < run.end && isEnabledIndex(selectedIndex + 1)) setSelectedIndex(selectedIndex + 1);
                } else if (current?.hasSubmenu) {
                    nav?.onOpenSubmenu?.(current);
                }
                break;
            case 'ArrowLeft':
                // Inside a swatch row Left steps back; from a row's start (or any text row) it leaves the submenu.
                if (run && selectedIndex > run.start) {
                    if (isEnabledIndex(selectedIndex - 1)) setSelectedIndex(selectedIndex - 1);
                } else {
                    nav?.onBack?.();
                }
                break;
            case 'Enter':
                if (!current) break;
                if (current.hasSubmenu) {
                    nav?.onOpenSubmenu?.(current);
                    break;
                }
                onActivate(current);
                break;
        }
    }, [allItems, isEnabledIndex, moveRow, params, selectedIndex, swatchRunAt]);

    const handleSearchChange = useCallback((text: string) => setSearchQuery(text), []);

    return {
        searchQuery,
        selectedIndex,
        filteredCategories,
        inputRef,
        handleSearchChange,
        handleKeyPress,
        setSelectedIndex: (idx: number) => setSelectedIndex(clampToEnabled(idx)),
    };
}
