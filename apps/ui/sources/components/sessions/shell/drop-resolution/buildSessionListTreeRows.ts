import type { TreeContainerDropZone, TreeRow, WindowBounds } from '@/components/ui/treeDragDrop';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import {
    buildSessionFolderGroupKey,
    resolveDurableWorkspaceRefForSessionListHeader,
} from '@/sync/domains/session/folders';
import {
    buildSessionWorkspaceOrderItemKey,
    buildSessionWorkspaceOrderScopeKey,
} from '@/sync/domains/session/listing/sessionWorkspaceOrderStateV1';

import type {
    SessionListTreeContainerMetadata,
    SessionListTreeDropZoneBounds,
    SessionListTreeModel,
    SessionListTreeRowMetadata,
} from './sessionListTreeTypes';
import { resolveWorkspaceRootTreeRowId, treeRowId } from './treeRowId';

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

function readHeaderRootGroupKey(item: Extract<SessionListIndexItem, { type: 'header' }>): string {
    const workspace = item.workspace ?? resolveDurableWorkspaceRefForSessionListHeader(item);
    if (!workspace) return readHeaderWorkspaceKey(item);
    return buildSessionFolderGroupKey({
        serverId: item.serverId,
        workspace,
        folderId: null,
    });
}

function readWorkspaceOrderContainerId(item: Extract<SessionListIndexItem, { type: 'header' }>): string {
    const serverId = String(item.serverId ?? '').trim() || '__unknown_server__';
    const section = String(item.headerKind ?? 'default').trim() || 'default';
    const groupKey = String(item.groupKey ?? '').trim();
    return `workspace-order:${serverId}:${section}:${groupKey}`;
}

function readDirectSessionGroupKey(item: Extract<SessionListIndexItem, { type: 'header' }>): string {
    return String(item.groupKey ?? item.title ?? '').trim();
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

function buildImplicitDropZoneBounds(anchor: WindowBounds, edge: 'top' | 'bottom'): WindowBounds {
    const height = Math.max(16, Math.min(anchor.height, 40));
    return {
        x: anchor.x,
        y: edge === 'top' ? anchor.y - height : anchor.y + anchor.height,
        width: anchor.width,
        height,
    };
}

function appendImplicitRootDropZones(params: Readonly<{
    rows: ReadonlyArray<TreeRow>;
    dropZones: TreeContainerDropZone[];
    rowMetadataById: ReadonlyMap<string, SessionListTreeRowMetadata>;
    containers: ReadonlyMap<string, SessionListTreeContainerMetadata>;
}>): void {
    const rowsById = new Map(params.rows.map((row) => [row.id, row]));
    for (const container of params.containers.values()) {
        const directRows = Array.from(params.rowMetadataById.values())
            .filter((metadata) => metadata.containerId === container.containerId
                && (container.kind === 'workspace-order'
                    ? metadata.kind === 'workspace-root'
                    : metadata.kind !== 'workspace-root'))
            .sort((left, right) => left.itemIndex - right.itemIndex)
            .map((metadata) => ({
                metadata,
                row: rowsById.get(metadata.rowId) ?? null,
            }))
            .filter((entry): entry is { metadata: SessionListTreeRowMetadata; row: TreeRow } => Boolean(entry.row));
        const first = directRows[0]?.row ?? null;
        const last = directRows[directRows.length - 1]?.row ?? null;
        if (!first || !last) continue;

        params.dropZones.push({
            containerId: container.containerId,
            rootId: container.rootId,
            parentId: container.parentRowId,
            depth: container.depth,
            bounds: buildImplicitDropZoneBounds(first.bounds, 'top'),
            role: 'root-before-first',
        });
        params.dropZones.push({
            containerId: container.containerId,
            rootId: container.rootId,
            parentId: container.parentRowId,
            depth: container.depth,
            bounds: buildImplicitDropZoneBounds(last.bounds, 'bottom'),
            role: 'root-after-last',
        });
        if (container.kind === 'workspace-order') continue;

        for (let index = 0; index < directRows.length - 1; index += 1) {
            const current = directRows[index];
            const next = directRows[index + 1];
            const subtreeRows = collectVisibleSubtreeRows({
                sourceRowId: current.metadata.rowId,
                rowsById,
                rowMetadataById: params.rowMetadataById,
            });
            const subtreeBottom = Math.max(
                current.row.bounds.y + current.row.bounds.height,
                ...subtreeRows.map((row) => row.bounds.y + row.bounds.height),
            );
            const gapHeight = next.row.bounds.y - subtreeBottom;
            if (gapHeight <= 0) continue;
            params.dropZones.push({
                containerId: container.containerId,
                rootId: container.rootId,
                parentId: container.parentRowId,
                depth: container.depth,
                bounds: {
                    x: next.row.bounds.x,
                    y: subtreeBottom,
                    width: next.row.bounds.width,
                    height: gapHeight,
                },
                role: 'sibling-before',
                targetId: next.metadata.rowId,
            });
        }
    }
}

function collectVisibleSubtreeRows(params: Readonly<{
    sourceRowId: string;
    rowsById: ReadonlyMap<string, TreeRow>;
    rowMetadataById: ReadonlyMap<string, SessionListTreeRowMetadata>;
}>): TreeRow[] {
    const descendants = new Set<string>([params.sourceRowId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const metadata of params.rowMetadataById.values()) {
            if (!metadata.parentRowId || descendants.has(metadata.rowId)) continue;
            if (!descendants.has(metadata.parentRowId)) continue;
            descendants.add(metadata.rowId);
            changed = true;
        }
    }
    return Array.from(descendants)
        .map((rowId) => params.rowsById.get(rowId))
        .filter((row): row is TreeRow => Boolean(row));
}

export function buildSessionListTreeRows(params: BuildSessionListTreeRowsParams): SessionListTreeModel {
    const rowMetadataById = new Map<string, SessionListTreeRowMetadata>();
    const containerMetadataById = new Map<string, SessionListTreeContainerMetadata>();
    const rows: TreeRow[] = [];
    const dropZones: TreeContainerDropZone[] = [];

    let activeRoot: SessionListTreeContainerMetadata | null = null;
    let activeWorkspaceOrderContainer: SessionListTreeContainerMetadata | null = null;
    const folderStack: FolderStackEntry[] = [];

    params.items.forEach((item, itemIndex) => {
        if (item.type === 'header' && item.headerKind !== 'project' && item.headerKind !== 'folder') {
            const containerId = readWorkspaceOrderContainerId(item);
            activeWorkspaceOrderContainer = {
                containerId,
                kind: 'workspace-order',
                rootId: containerId,
                groupKey: buildSessionWorkspaceOrderScopeKey(item.serverId),
                parentRowId: null,
                folderId: null,
                depth: 0,
                workspace: null,
            };
            registerContainer(containerMetadataById, activeWorkspaceOrderContainer);
            const directGroupKey = readDirectSessionGroupKey(item);
            if (directGroupKey) {
                activeRoot = {
                    containerId: directGroupKey,
                    kind: 'children',
                    rootId: directGroupKey,
                    groupKey: directGroupKey,
                    parentRowId: null,
                    folderId: null,
                    depth: 0,
                    workspace: item.workspace ?? null,
                };
                registerContainer(containerMetadataById, activeRoot);
            } else {
                activeRoot = null;
            }
            folderStack.length = 0;
            return;
        }

        if (item.type === 'header' && item.headerKind === 'project') {
            const workspaceKey = readHeaderWorkspaceKey(item);
            if (!workspaceKey) {
                activeRoot = null;
                folderStack.length = 0;
                return;
            }
            const groupKey = readHeaderRootGroupKey(item);
            const rowId = resolveWorkspaceRootTreeRowId(item);
            if (!activeWorkspaceOrderContainer) {
                const containerId = `workspace-order:${String(item.serverId ?? '').trim() || '__unknown_server__'}:default`;
                activeWorkspaceOrderContainer = {
                    containerId,
                    kind: 'workspace-order',
                    rootId: containerId,
                    groupKey: buildSessionWorkspaceOrderScopeKey(item.serverId),
                    parentRowId: null,
                    folderId: null,
                    depth: 0,
                    workspace: null,
                };
                registerContainer(containerMetadataById, activeWorkspaceOrderContainer);
            }
            activeRoot = {
                containerId: rowId,
                kind: 'children',
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
                containerId: activeWorkspaceOrderContainer.containerId,
                containerGroupKey: activeWorkspaceOrderContainer.groupKey,
                parentRowId: null,
                orderKey: buildSessionWorkspaceOrderItemKey(item.workspaceKey ?? workspaceKey),
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
                kind: 'children',
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

    appendImplicitRootDropZones({
        rows,
        dropZones,
        rowMetadataById,
        containers: containerMetadataById,
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
