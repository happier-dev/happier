import type { SessionListViewItem } from '@/sync/domains/state/storage';

export type SessionListSelectedSessionItem = Extract<SessionListViewItem, { type: 'session' }> & {
    selected: boolean;
};

export type SessionListSelectedItem =
    | Extract<SessionListViewItem, { type: 'header' }>
    | SessionListSelectedSessionItem;

/**
 * Reuse test for the selectable pass. It is the last transform before the list's `data`, so a field
 * it omits is a field whose freshly computed value is thrown away in favour of the previous row.
 *
 * The placement fields therefore have to be here even though `session` identity often moves with
 * them: a placement can change on its own. `applySessionListIndexPlacementWithinGroups` restamps
 * only `attentionPromotionReason` — group, section, variant and pinned are untouched — and
 * default-derived attention standing deliberately does not restamp `keepVisibleWhenInactive`, so the
 * session object stays identical. This list is the one `areSessionListIndexItemsEqual` and
 * `canReuseSession` already agree on, restricted to the fields a view item carries.
 */
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
        && previous.serverName === item.serverName
        && previous.groupKey === item.groupKey
        && previous.groupKind === item.groupKind
        && previous.variant === item.variant
        && previous.pinned === item.pinned
        && previous.section === item.section
        && (previous.attentionPromotionReason ?? null) === (item.attentionPromotionReason ?? null)
        && (previous.workingPlacementReason ?? null) === (item.workingPlacementReason ?? null)
        && (previous.folderId ?? null) === (item.folderId ?? null)
        && (previous.folderDepth ?? null) === (item.folderDepth ?? null);
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
