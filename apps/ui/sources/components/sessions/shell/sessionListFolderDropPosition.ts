import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

export type SessionListFolderDropPlacement = Readonly<{
    parentId: string | null;
    beforeFolderId?: string | null;
    afterFolderId?: string | null;
}>;

function resolveProjectGroupKey(groupKey: string | null | undefined): string {
    const value = String(groupKey ?? '').trim();
    const folderIndex = value.indexOf(':folder:');
    return folderIndex >= 0 ? value.slice(0, folderIndex) : value;
}

function isFolderHeader(item: SessionListIndexItem | undefined): item is Extract<SessionListIndexItem, { type: 'header' }> & Readonly<{ folderId: string }> {
    return item?.type === 'header'
        && item.headerKind === 'folder'
        && typeof item.folderId === 'string'
        && item.folderId.trim().length > 0;
}

function isInSourceFolderSubtree(item: SessionListIndexItem, sourceDepth: number): boolean {
    if (item.type === 'session') {
        return typeof item.folderDepth === 'number' && item.folderDepth > sourceDepth;
    }
    return isFolderHeader(item) && typeof item.folderDepth === 'number' && item.folderDepth > sourceDepth;
}

function findSourceSubtreeEnd(items: ReadonlyArray<SessionListIndexItem>, sourceIndex: number, sourceDepth: number): number {
    let cursor = sourceIndex + 1;
    while (cursor < items.length && isInSourceFolderSubtree(items[cursor]!, sourceDepth)) {
        cursor += 1;
    }
    return cursor;
}

function resolveItemProjectGroupKey(item: SessionListIndexItem): string {
    return resolveProjectGroupKey(item.groupKey);
}

function resolveFolderParentIdFromVisibleItems(
    items: ReadonlyArray<SessionListIndexItem>,
    folderIndex: number,
): string | null {
    const folder = items[folderIndex];
    if (!isFolderHeader(folder)) return null;
    const depth = typeof folder.folderDepth === 'number' ? folder.folderDepth : 0;
    if (depth <= 0) return null;
    for (let index = folderIndex - 1; index >= 0; index -= 1) {
        const candidate = items[index];
        if (!isFolderHeader(candidate)) continue;
        const candidateDepth = typeof candidate.folderDepth === 'number' ? candidate.folderDepth : 0;
        if (candidateDepth < depth) return candidate.folderId;
    }
    return null;
}

function resolvePlacementBeforeItem(
    items: ReadonlyArray<SessionListIndexItem>,
    itemIndex: number,
    item: SessionListIndexItem | undefined,
    sourceProjectGroupKey: string,
): SessionListFolderDropPlacement | null {
    if (!item || resolveItemProjectGroupKey(item) !== sourceProjectGroupKey) return null;
    if (item.type === 'session') return { parentId: item.folderId ?? null };
    if (isFolderHeader(item)) {
        return {
            parentId: resolveFolderParentIdFromVisibleItems(items, itemIndex),
            beforeFolderId: item.folderId,
        };
    }
    return item.headerKind === 'project' ? { parentId: null } : null;
}

function resolvePlacementAfterItem(
    items: ReadonlyArray<SessionListIndexItem>,
    itemIndex: number,
    item: SessionListIndexItem | undefined,
    sourceProjectGroupKey: string,
): SessionListFolderDropPlacement | null {
    if (!item || resolveItemProjectGroupKey(item) !== sourceProjectGroupKey) return null;
    if (item.type === 'session') return { parentId: item.folderId ?? null };
    if (isFolderHeader(item)) {
        return {
            parentId: resolveFolderParentIdFromVisibleItems(items, itemIndex),
            afterFolderId: item.folderId,
        };
    }
    return item.headerKind === 'project' ? { parentId: null } : null;
}

export function resolveSessionListFolderDropPlacement(params: Readonly<{
    items: ReadonlyArray<SessionListIndexItem>;
    folderId: string;
    positionDelta: number;
}>): SessionListFolderDropPlacement | null {
    const sourceIndex = params.items.findIndex((item) => isFolderHeader(item) && item.folderId === params.folderId);
    const source = sourceIndex >= 0 ? params.items[sourceIndex] : null;
    if (!isFolderHeader(source) || params.positionDelta === 0) return null;

    const sourceDepth = typeof source.folderDepth === 'number' ? source.folderDepth : 0;
    const sourceProjectGroupKey = resolveProjectGroupKey(source.groupKey);
    if (!sourceProjectGroupKey) return null;

    const subtreeEnd = findSourceSubtreeEnd(params.items, sourceIndex, sourceDepth);
    const rawLineIndex = params.positionDelta > 0
        ? sourceIndex + params.positionDelta + 1
        : sourceIndex + params.positionDelta;
    const lineIndex = Math.max(0, Math.min(params.items.length, rawLineIndex));
    if (lineIndex > sourceIndex && lineIndex <= subtreeEnd) return null;

    const removedCountBeforeLine = lineIndex > subtreeEnd ? subtreeEnd - sourceIndex : 0;
    const compactedItems = params.items.filter((_, index) => index < sourceIndex || index >= subtreeEnd);
    const insertionIndex = Math.max(0, Math.min(compactedItems.length, lineIndex - removedCountBeforeLine));

    return resolvePlacementBeforeItem(compactedItems, insertionIndex, compactedItems[insertionIndex], sourceProjectGroupKey)
        ?? resolvePlacementAfterItem(compactedItems, insertionIndex - 1, compactedItems[insertionIndex - 1], sourceProjectGroupKey);
}
