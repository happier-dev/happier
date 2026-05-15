import type { TreeContainerDropZone, TreeRow, WindowBounds } from '@/components/ui/treeDragDrop';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import type {
    SessionListTreeContainerMetadata,
    SessionListTreeDropZoneBounds,
    SessionListTreeModel,
    SessionListTreeRowMetadata,
} from './sessionListTreeTypes';
import { treeRowId } from './treeRowId';

type FolderStackEntry = Readonly<{
    rowId: string;
    childGroupKey: string;
    rootId: string;
    workspace: SessionListTreeRowMetadata['workspace'];
}>;

export type BuildSessionListTreeRowsParams = Readonly<{
    items: ReadonlyArray<SessionListIndexItem>;
    rowBoundsById?: ReadonlyMap<string, WindowBounds> | Readonly<Record<string, WindowBounds | undefined>>;
    dropZoneBounds?: ReadonlyArray<SessionListTreeDropZoneBounds>;
}>;

function readBounds(
    source: BuildSessionListTreeRowsParams['rowBoundsById'],
    rowId: string,
): WindowBounds | null {
    if (!source) return null;
    const mapLikeSource = source as ReadonlyMap<string, WindowBounds>;
    if (typeof mapLikeSource.get === 'function') return mapLikeSource.get(rowId) ?? null;
    const recordSource = source as Readonly<Record<string, WindowBounds | undefined>>;
    return recordSource[rowId] ?? null;
}

function normalizeDepth(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function readHeaderWorkspaceKey(item: Extract<SessionListIndexItem, { type: 'header' }>): string {
    return String(item.groupKey ?? item.workspaceKey ?? item.title ?? '').trim();
}

function buildSessionOrderKey(item: Extract<SessionListIndexItem, { type: 'session' }>): string | null {
    const serverId = String(item.serverId ?? '').trim();
    const sessionId = String(item.sessionId ?? '').trim();
    return serverId && sessionId ? `${serverId}:${sessionId}` : null;
}

function buildFolderOrderKey(folderId: string | null): string | null {
    return folderId ? `folder:${folderId}` : null;
}

function registerContainer(
    containers: Map<string, SessionListTreeContainerMetadata>,
    metadata: SessionListTreeContainerMetadata,
): void {
    containers.set(metadata.containerId, metadata);
}

function buildTreeRow(metadata: SessionListTreeRowMetadata, bounds: WindowBounds | null): TreeRow | null {
    if (!bounds) return null;
    return {
        id: metadata.rowId,
        parentId: metadata.parentRowId,
        containerId: metadata.containerId,
        depth: metadata.folderDepth,
        kind: metadata.kind === 'session' ? 'leaf' : 'container',
        bounds,
    };
}

export function buildSessionListTreeRows(params: BuildSessionListTreeRowsParams): SessionListTreeModel {
    const rowMetadataById = new Map<string, SessionListTreeRowMetadata>();
    const containerMetadataById = new Map<string, SessionListTreeContainerMetadata>();
    const rows: TreeRow[] = [];
    const dropZones: TreeContainerDropZone[] = [];

    let activeRoot: SessionListTreeContainerMetadata | null = null;
    const folderStack: FolderStackEntry[] = [];

    params.items.forEach((item, itemIndex) => {
        if (item.type === 'header' && item.headerKind === 'project') {
            const groupKey = readHeaderWorkspaceKey(item);
            if (!groupKey) {
                activeRoot = null;
                folderStack.length = 0;
                return;
            }
            const rowId = treeRowId.workspaceRoot(groupKey);
            activeRoot = {
                containerId: rowId,
                rootId: rowId,
                groupKey,
                parentRowId: null,
                folderId: null,
                depth: 0,
                workspace: item.workspace ?? null,
            };
            registerContainer(containerMetadataById, activeRoot);
            folderStack.length = 0;

            const metadata: SessionListTreeRowMetadata = {
                rowId,
                item,
                itemIndex,
                kind: 'workspace-root',
                rootId: rowId,
                containerId: rowId,
                containerGroupKey: groupKey,
                parentRowId: null,
                orderKey: null,
                serverId: typeof item.serverId === 'string' ? item.serverId : null,
                sessionId: null,
                folderId: null,
                folderDepth: 0,
                workspace: item.workspace ?? null,
                childContainerId: rowId,
                childGroupKey: groupKey,
                storageKind: null,
            };
            rowMetadataById.set(rowId, metadata);
            const row = buildTreeRow(metadata, readBounds(params.rowBoundsById, rowId));
            if (row) rows.push(row);
            return;
        }

        if (!activeRoot) return;

        if (item.type === 'header' && item.headerKind === 'folder' && item.folderId) {
            const depth = normalizeDepth(item.folderDepth);
            folderStack.length = Math.min(folderStack.length, depth);
            const parent = depth > 0 ? folderStack[depth - 1] ?? null : null;
            const containerId = parent?.rowId ?? activeRoot.containerId;
            const containerGroupKey = parent?.childGroupKey ?? activeRoot.groupKey;
            const rowId = treeRowId.folder(item.folderId);
            const groupKey = String(item.groupKey ?? '').trim();

            const metadata: SessionListTreeRowMetadata = {
                rowId,
                item,
                itemIndex,
                kind: 'folder',
                rootId: activeRoot.rootId,
                containerId,
                containerGroupKey,
                parentRowId: parent?.rowId ?? null,
                orderKey: buildFolderOrderKey(item.folderId),
                serverId: typeof item.serverId === 'string' ? item.serverId : null,
                sessionId: null,
                folderId: item.folderId,
                folderDepth: depth,
                workspace: item.workspace ?? activeRoot.workspace,
                childContainerId: rowId,
                childGroupKey: groupKey || null,
                storageKind: null,
            };
            rowMetadataById.set(rowId, metadata);
            registerContainer(containerMetadataById, {
                containerId: rowId,
                rootId: activeRoot.rootId,
                groupKey: groupKey || containerGroupKey,
                parentRowId: parent?.rowId ?? null,
                folderId: item.folderId,
                depth: depth + 1,
                workspace: item.workspace ?? activeRoot.workspace,
            });
            folderStack[depth] = {
                rowId,
                childGroupKey: groupKey || containerGroupKey,
                rootId: activeRoot.rootId,
                workspace: item.workspace ?? activeRoot.workspace,
            };
            folderStack.length = depth + 1;
            const row = buildTreeRow(metadata, readBounds(params.rowBoundsById, rowId));
            if (row) rows.push(row);
            return;
        }

        if (item.type === 'session') {
            const folderId = typeof item.folderId === 'string' && item.folderId.trim() ? item.folderId.trim() : null;
            const parentRowId = folderId ? treeRowId.folder(folderId) : null;
            const containerId = parentRowId ?? activeRoot.containerId;
            const container = containerMetadataById.get(containerId) ?? activeRoot;
            const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
            const sessionId = String(item.sessionId ?? '').trim();
            if (!sessionId) return;
            const rowId = serverId ? treeRowId.session(serverId, sessionId) : `session:${sessionId}`;
            const metadata: SessionListTreeRowMetadata = {
                rowId,
                item,
                itemIndex,
                kind: 'session',
                rootId: container.rootId,
                containerId,
                containerGroupKey: container.groupKey,
                parentRowId,
                orderKey: buildSessionOrderKey(item),
                serverId: serverId || null,
                sessionId,
                folderId,
                folderDepth: normalizeDepth(item.folderDepth),
                workspace: item.workspace ?? container.workspace,
                childContainerId: null,
                childGroupKey: null,
                storageKind: item.storageKind ?? 'persisted',
            };
            rowMetadataById.set(rowId, metadata);
            const row = buildTreeRow(metadata, readBounds(params.rowBoundsById, rowId));
            if (row) rows.push(row);
        }
    });

    for (const zone of params.dropZoneBounds ?? []) {
        const container = containerMetadataById.get(zone.containerId);
        if (!container) continue;
        dropZones.push({
            containerId: container.containerId,
            rootId: container.rootId,
            parentId: container.parentRowId,
            depth: container.depth,
            bounds: zone.bounds,
            role: zone.role,
        });
    }

    return {
        items: params.items,
        rows,
        dropZones,
        rowMetadataById,
        containerMetadataById,
    };
}
