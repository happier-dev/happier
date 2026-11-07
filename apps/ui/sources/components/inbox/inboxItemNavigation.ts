import type { InboxItem } from './inboxItems';
import { createInboxItemRoute, type InboxItemFocus } from './inboxItemFocus';

/** The one identity a selection is matched by: the address the Inbox route carries (`?item=`). */
export function readInboxItemSelectionKey(focus: InboxItemFocus | null): string | null {
    return focus ? createInboxItemRoute(focus).params.item : null;
}

/**
 * The row a selection points at. Every route key encodes its kind and id, so only rows with both can match;
 * the full address is derived for those alone, never once per Inbox row.
 */
export function findInboxItemForFocus<T extends Pick<InboxItem, 'focus'>>(
    items: readonly T[], focus: InboxItemFocus | null,
): T | undefined {
    const target = readInboxItemSelectionKey(focus);
    if (target === null || !focus) return undefined;
    return items.find(item => item.focus.id === focus.id && item.focus.kind === focus.kind
        && readInboxItemSelectionKey(item.focus) === target);
}

type NavigationItem = Pick<InboxItem, 'key' | 'focus' | 'view'>;

export function moveInboxItem(
    items: readonly NavigationItem[], selectedKey: string | null, direction: -1 | 1,
): NavigationItem | null {
    if (items.length === 0) return null;
    const index = items.findIndex(item => item.key === selectedKey);
    if (index < 0) return direction === 1 ? items[0]! : items[items.length - 1]!;
    return items[Math.max(0, Math.min(items.length - 1, index + direction))]!;
}
