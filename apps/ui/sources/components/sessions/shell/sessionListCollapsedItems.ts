import type { SessionListViewItem } from '@/sync/domains/state/storage';

const SECTION_HEADER_KINDS = new Set(['active', 'inactive', 'pinned']);

function readFolderId(item: Extract<SessionListViewItem, { type: 'header' }> | Extract<SessionListViewItem, { type: 'session' }>): string | null {
    const value = item.folderId;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readParentFolderId(item: Extract<SessionListViewItem, { type: 'header' }>): string | null {
    const value = item.parentFolderId;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

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
    const collapsedFolderIds = new Set<string>();
    // Nested rows are emitted directly after their parent and share its visibility,
    // not the group or folder they would occupy as top-level rows.
    let parentHidden = false;

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
                collapsedFolderIds.clear();
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
            if (kind === 'folder') {
                const folderId = readFolderId(item);
                const parentFolderId = readParentFolderId(item);
                if (folderId) {
                    if (parentFolderId && collapsedFolderIds.has(parentFolderId)) {
                        collapsedFolderIds.add(folderId);
                        ensureResult(index);
                        continue;
                    }
                    const collapseKey = item.groupKey ?? '';
                    if (collapseKey && keys[collapseKey]) {
                        collapsedFolderIds.add(folderId);
                    }
                }
            }
            if (result !== undefined) result.push(item);
            continue;
        }

        if (skipUntilNextSection) {
            ensureResult(index);
            continue;
        }

        const nested = (item.nestingDepth ?? 0) > 0;
        const groupKey = item.groupKey ?? '';
        const folderId = readFolderId(item);
        const hidden: boolean = nested
            ? parentHidden
            : Boolean((folderId && collapsedFolderIds.has(folderId)) || (groupKey && keys[groupKey]));
        if (!nested) parentHidden = hidden;
        if (hidden) {
            ensureResult(index);
            continue;
        }
        if (result !== undefined) result.push(item);
    }

    return result ?? (items as SessionListViewItem[]);
}
