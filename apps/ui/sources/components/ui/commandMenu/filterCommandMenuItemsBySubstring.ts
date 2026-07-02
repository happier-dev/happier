import type { CommandMenuItem } from './commandMenuTypes';

/**
 * Orca-style substring match: builds `[label, ...aliases].join(' ').toLowerCase()`
 * and tests `haystack.includes(query.trim().toLowerCase())`. Empty query returns all items.
 * Stable order: preserves input order. Hosts that want fuzzy scoring use their own filter.
 */
export function filterCommandMenuItemsBySubstring<T extends CommandMenuItem>(
    items: readonly T[],
    query: string,
): readonly T[] {
    const trimmed = query.trim().toLowerCase();
    if (trimmed.length === 0) return items;

    return items.filter((item) => {
        const haystack = [item.label, ...(item.aliases ?? [])].join(' ').toLowerCase();
        return haystack.includes(trimmed);
    });
}
