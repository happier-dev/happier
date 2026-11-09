import type { TreeContainerDropZone, TreeRow, WindowBounds } from '@/components/ui/treeDragDrop';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { buildSessionListFolderOrderItemKey } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
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
import { readSessionListItemProjectKey } from './sessionListDestinationScope';

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

function readWorkspaceOrderContainerId(item: Extract<SessionListIndexItem, { type: 'header' }>): string {
    const serverId = String(item.serverId ?? '').trim() || null;
    const section = String(item.headerKind ?? 'default').trim() || 'default';
    return JSON.stringify(['workspace-order-container', serverId, section]);
}

function readDirectSessionGroupKey(item: Extract<SessionListIndexItem, { type: 'header' }>): string {
    return String(item.groupKey ?? item.title ?? '').trim();
}

function buildSessionOrderKey(item: Extract<SessionListIndexItem, { type: 'session' }>): string | null {
    const serverId = String(item.serverId ?? '').trim();
    const sessionId = String(item.sessionId ?? '').trim();
    return serverId && sessionId ? sessionAddressKey({ serverId, sessionId }) : null;
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
    const sectionContainerByGroupKey = new Map<string, SessionListTreeContainerMetadata>();
    const rows: TreeRow[] = [];
    const dropZones: TreeContainerDropZone[] = [];

    let activeRoot: SessionListTreeContainerMetadata | null = null;
    let activeWorkspaceOrderContainer: SessionListTreeContainerMetadata | null = null;

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
                    serverId: item.serverId ?? null,
                    destinationKind: item.headerKind === 'pinned' ? 'pinned' : 'other',
                };
                registerContainer(containerMetadataById, activeRoot);
            } else {
                activeRoot = null;
            }
            return;
        }

        if (item.type === 'header' && item.headerKind === 'project') {
            const workspaceKey = readHeaderWorkspaceKey(item);
            if (!workspaceKey) {
                activeRoot = null;
                return;
            }
            const groupKey = readHeaderWorkspaceKey(item);
            const rowId = resolveWorkspaceRootTreeRowId(item);
            if (!activeWorkspaceOrderContainer) {
                const serverId = String(item.serverId ?? '').trim() || null;
                const containerId = JSON.stringify(['workspace-order-container', serverId, 'default']);
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
                serverId: item.serverId ?? item.workspace?.serverId ?? null,
                destinationKind: 'project',
                projectKey: readSessionListItemProjectKey(item),
            };
            registerContainer(containerMetadataById, activeRoot);

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

        if (item.type === 'header' && item.headerKind === 'folder' && item.folderId) {
            const serverId = String(item.serverId ?? item.workspace?.serverId ?? '').trim();
            if (!serverId) return;
            const rootId = JSON.stringify(['session-sections', serverId]);
            const sectionRoot: SessionListTreeContainerMetadata = { containerId: rootId, kind: 'children', rootId, groupKey: rootId,
                parentRowId: null, folderId: null, depth: 0, workspace: null, serverId,
                destinationKind: 'section-order' };
            registerContainer(containerMetadataById, sectionRoot);
            activeRoot ??= sectionRoot;
            const containerId = rootId;
            const containerGroupKey = rootId;
            const rowId = treeRowId.folder(serverId, item.folderId);
            const groupKey = String(item.groupKey ?? '').trim();

            const metadata: SessionListTreeRowMetadata = {
                rowId,
                item,
                itemIndex,
                kind: 'folder',
                rootId,
                containerId,
                containerGroupKey,
                parentRowId: null,
                orderKey: buildSessionListFolderOrderItemKey({
                    serverId: item.serverId ?? item.workspace?.serverId ?? null,
                    folderId: item.folderId,
                }),
                serverId,
                sessionId: null,
                folderId: item.folderId,
                folderDepth: 0,
                workspace: null,
                childContainerId: rowId,
                childGroupKey: groupKey || null,
                storageKind: null,
            };
            rowMetadataById.set(rowId, metadata);
            const sectionContainer: SessionListTreeContainerMetadata = {
                containerId: rowId,
                kind: 'children',
                rootId,
                groupKey: groupKey || containerGroupKey,
                parentRowId: null,
                folderId: item.folderId,
                depth: 1,
                workspace: null,
                serverId,
                destinationKind: 'section',
            };
            registerContainer(containerMetadataById, sectionContainer);
            if (groupKey) sectionContainerByGroupKey.set(groupKey, sectionContainer);
            const row = buildTreeRow(metadata, readBounds(params.rowBoundsById, rowId));
            if (row) rows.push(row);
            return;
        }

        if (!activeRoot) return;

        if (item.type === 'session') {
            const folderId = typeof item.folderId === 'string' && item.folderId.trim() ? item.folderId.trim() : null;
            // The list projection owns the order scope. Without folder projection, Project rows
            // keep their Project group key; inventing a folder-root key writes an invisible order.
            const groupKey = typeof item.groupKey === 'string' ? item.groupKey.trim() : '';
            if (!folderId && groupKey && activeRoot.groupKey !== groupKey) {
                activeRoot = { ...activeRoot, groupKey };
                registerContainer(containerMetadataById, activeRoot);
            }
            const serverId = typeof item.serverId === 'string'
                ? item.serverId.trim()
                : item.workspace?.serverId?.trim() ?? '';
            // Membership and visible placement differ for pins and filed children under a lead.
            // The list's projected group owns geometry; folderId remains the stored assignment.
            const presentationSection = item.groupKind === 'folder' ? sectionContainerByGroupKey.get(groupKey) : null;
            const parentRowId = presentationSection?.containerId ?? null;
            const containerId = parentRowId ?? activeRoot.containerId;
            const container = presentationSection ?? containerMetadataById.get(containerId) ?? activeRoot;
            const sessionId = String(item.sessionId ?? '').trim();
            if (!sessionId) return;
            const rowId = serverId
                ? treeRowId.session(serverId, sessionId, item.keyParts, item.occurrenceRole)
                : JSON.stringify(['session', null, sessionId]);
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
