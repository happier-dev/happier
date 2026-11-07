import type { SessionListViewItem } from '@/sync/domains/state/storage';
import type {
    SessionFolderViewModeV1,
    SessionFolderWorkspaceRefV1,
} from '@/sync/domains/session/folders';
export type { SessionFolderViewModeV1, SessionFolderWorkspaceRefV1 };

type SessionListHeaderItemBase = Omit<Extract<SessionListViewItem, { type: 'header' }>, 'headerKind'>;

export type SessionFolderHeaderItem = SessionListHeaderItemBase & Readonly<{
    headerKind: 'folder';
    folderId: string;
    parentFolderId: string | null;
    depth: number;
    sessionCount: number;
    workspace?: SessionFolderWorkspaceRefV1;
    renderWorkspaceKey?: string;
}>;

export type SessionFolderSessionItem = Extract<SessionListViewItem, { type: 'session' }> & Readonly<{
    folderId?: string | null;
    folderDepth?: number;
}>;

export function asSessionFolderHeaderItem(
    item: Extract<SessionListViewItem, { type: 'header' }>,
): SessionFolderHeaderItem | null {
    const candidate = item as Partial<SessionFolderHeaderItem> & { headerKind?: string };
    return candidate.headerKind === 'folder' && typeof candidate.folderId === 'string' && candidate.folderId.trim().length > 0
        ? candidate as SessionFolderHeaderItem
        : null;
}

export function isSessionFolderHeaderItem(
    item: Extract<SessionListViewItem, { type: 'header' }>,
): boolean {
    return asSessionFolderHeaderItem(item) !== null;
}

export function readSessionFolderId(item: Extract<SessionListViewItem, { type: 'session' }>): string | null {
    const folderId = (item as Partial<SessionFolderSessionItem>).folderId;
    return typeof folderId === 'string' && folderId.trim().length > 0 ? folderId.trim() : null;
}

export function readSessionFolderDepth(item: Extract<SessionListViewItem, { type: 'session' }>): number {
    const rawDepth = (item as Partial<SessionFolderSessionItem>).folderDepth;
    return typeof rawDepth === 'number' && Number.isFinite(rawDepth)
        ? Math.max(0, Math.trunc(rawDepth))
        : 0;
}

export function buildSessionFolderBreadcrumbs(
    items: ReadonlyArray<SessionListViewItem>,
    folderId: string | null,
): SessionFolderHeaderItem[] {
    if (!folderId) return [];
    const foldersById = new Map<string, SessionFolderHeaderItem>();
    for (const item of items) {
        if (item.type !== 'header') continue;
        const folder = asSessionFolderHeaderItem(item);
        if (folder) foldersById.set(folder.folderId, folder);
    }

    const out: SessionFolderHeaderItem[] = [];
    const seen = new Set<string>();
    let cursor: string | null = folderId;
    while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const folder = foldersById.get(cursor);
        if (!folder) break;
        out.push(folder);
        cursor = folder.parentFolderId ?? null;
    }
    out.reverse();
    return out;
}

export function filterSessionListItemsByFocusedFolder(
    items: ReadonlyArray<SessionListViewItem>,
    folderId: string | null,
): SessionListViewItem[] {
    if (!folderId) return [...items];

    const parentByFolderId = new Map<string, string | null>();
    for (const item of items) {
        if (item.type !== 'header') continue;
        const folder = asSessionFolderHeaderItem(item);
        if (!folder) continue;
        parentByFolderId.set(folder.folderId, folder.parentFolderId ?? null);
    }

    const includedFolderIds = new Set<string>([folderId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const [candidateId, parentId] of parentByFolderId.entries()) {
            if (!parentId || !includedFolderIds.has(parentId) || includedFolderIds.has(candidateId)) continue;
            includedFolderIds.add(candidateId);
            changed = true;
        }
    }

    const includedItems = new Set<SessionListViewItem>();
    let projectHeader: SessionListViewItem | null = null;
    for (const item of items) {
        if (item.type === 'header') {
            if (item.headerKind === 'project') {
                projectHeader = item;
                continue;
            }
            const folder = asSessionFolderHeaderItem(item);
            if (!folder) {
                projectHeader = null;
                continue;
            }
            if (!includedFolderIds.has(folder.folderId)) continue;
        } else {
            const rowFolderId = readSessionFolderId(item);
            if (rowFolderId == null || !includedFolderIds.has(rowFolderId)) continue;
        }
        includedItems.add(item);
        if (projectHeader) includedItems.add(projectHeader);
    }

    return items.filter((item) => {
        if (item.type === 'header'
            && (item.headerKind === 'active' || item.headerKind === 'inactive' || item.headerKind === 'sessions')) return true;
        return includedItems.has(item);
    });
}
