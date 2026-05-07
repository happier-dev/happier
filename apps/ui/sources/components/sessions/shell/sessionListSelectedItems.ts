import type { SessionListViewItem } from '@/sync/domains/state/storage';

export type SessionListSelectedSessionItem = Extract<SessionListViewItem, { type: 'session' }> & {
    selected: boolean;
};

export type SessionListSelectedItem =
    | Extract<SessionListViewItem, { type: 'header' }>
    | SessionListSelectedSessionItem;

function isSameSessionListItem(
    previous: SessionListSelectedItem | undefined,
    item: SessionListViewItem,
): boolean {
    if (!previous || previous.type !== item.type) return false;
    if (item.type === 'header') {
        return previous === item;
    }
    return previous.type === 'session'
        && previous.session === item.session
        && previous.serverId === item.serverId
        && previous.groupKey === item.groupKey
        && previous.groupKind === item.groupKind
        && previous.variant === item.variant
        && previous.pinned === item.pinned
        && previous.section === item.section;
}

export function buildSessionListSelectedItems(input: Readonly<{
    items: ReadonlyArray<SessionListViewItem> | null | undefined;
    pathname: string;
    selectable: boolean;
    previousItems?: ReadonlyArray<SessionListSelectedItem> | null;
}>): ReadonlyArray<SessionListSelectedItem> | null | undefined {
    const items = input.items;
    if (!items || !input.selectable) {
        return items as ReadonlyArray<SessionListSelectedItem> | null | undefined;
    }

    const previousItems = input.previousItems;
    let reusedAll = Array.isArray(previousItems) && previousItems.length === items.length;
    const next: SessionListSelectedItem[] = [];

    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item.type === 'header') {
            next.push(item);
            reusedAll = reusedAll && previousItems?.[index] === item;
            continue;
        }

        const selected = input.pathname.startsWith(`/session/${item.session.id}`);
        const previous = previousItems?.[index];
        if (
            isSameSessionListItem(previous, item)
            && previous?.type === 'session'
            && previous.selected === selected
        ) {
            next.push(previous);
            continue;
        }

        reusedAll = false;
        next.push({
            ...item,
            selected,
        });
    }

    return reusedAll && previousItems ? previousItems : next;
}
