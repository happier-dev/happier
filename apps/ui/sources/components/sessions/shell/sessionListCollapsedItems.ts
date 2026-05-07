import type { SessionListViewItem } from '@/sync/domains/state/storage';

const SECTION_HEADER_KINDS = new Set(['active', 'inactive', 'pinned']);

export function countCollapsedSessionListGroups(keys: Readonly<Record<string, boolean>> | null | undefined): number {
    if (!keys) return 0;
    let groups = 0;
    for (const value of Object.values(keys)) {
        if (value === true) groups += 1;
    }
    return groups;
}

export function filterCollapsedSessionListItems(
    items: ReadonlyArray<SessionListViewItem>,
    collapsedGroupKeysV1: Readonly<Record<string, boolean> | null | undefined>,
): SessionListViewItem[] {
    if (items.length === 0) {
        return items as SessionListViewItem[];
    }

    const keys = collapsedGroupKeysV1 ?? {};
    if (Object.keys(keys).length === 0) {
        return items as SessionListViewItem[];
    }

    let result: SessionListViewItem[] | undefined;
    let skipUntilNextSection = false;

    const ensureResult = (index: number): SessionListViewItem[] => {
        if (result !== undefined) return result;
        result = items.slice(0, index) as SessionListViewItem[];
        return result;
    };

    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item.type === 'header') {
            const kind = item.headerKind ?? '';
            const isSection = SECTION_HEADER_KINDS.has(kind);

            if (isSection) {
                skipUntilNextSection = false;
                const collapseKey = item.groupKey || `${kind}:${item.serverId ?? 'local'}`;
                if (keys[collapseKey]) {
                    ensureResult(index).push(item);
                    skipUntilNextSection = true;
                } else if (result !== undefined) {
                    result.push(item);
                }
                continue;
            }

            if (skipUntilNextSection) {
                ensureResult(index);
                continue;
            }
            if (result !== undefined) result.push(item);
            continue;
        }

        if (skipUntilNextSection) {
            ensureResult(index);
            continue;
        }

        const groupKey = item.groupKey ?? '';
        if (groupKey && keys[groupKey]) {
            ensureResult(index);
            continue;
        }
        if (result !== undefined) result.push(item);
    }

    return result ?? (items as SessionListViewItem[]);
}
