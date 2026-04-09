import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

const sectionKinds = new Set(['active', 'inactive', 'pinned']);

export function filterCollapsedSessionListItems(
    items: ReadonlyArray<SessionListIndexItem>,
    collapsedGroupKeysV1: Readonly<Record<string, boolean> | null | undefined>,
): SessionListIndexItem[] {
    if (items.length === 0) {
        return items as SessionListIndexItem[];
    }

    const keys = collapsedGroupKeysV1 ?? {};
    if (Object.keys(keys).length === 0) {
        return items as SessionListIndexItem[];
    }

    let result: SessionListIndexItem[] | undefined;
    let skipUntilNextSection = false;

    const ensureResult = (index: number): SessionListIndexItem[] => {
        if (result !== undefined) return result;
        result = items.slice(0, index) as SessionListIndexItem[];
        return result;
    };

    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item.type === 'header') {
            const kind = item.headerKind ?? '';
            const isSection = sectionKinds.has(kind);

            if (isSection) {
                skipUntilNextSection = false;
                const collapseKey = item.groupKey || `${kind}:${item.serverId ?? 'local'}`;
                if (keys[collapseKey]) {
                    const filteredItems = ensureResult(index);
                    filteredItems.push(item);
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

    return result ?? (items as SessionListIndexItem[]);
}
