import type { TreeDropResult } from '@/components/ui/treeDragDrop';
import { canReorderSessionListSourceAroundTarget } from './sessionListDestinationScope';

import type {
    SessionListFolderSortMode,
    SessionListTreeDragSource,
    SessionListTreeModel,
    SessionListTreeRowMetadata,
} from './sessionListTreeTypes';

function orderedContainerChildren(params: Readonly<{
    tree: SessionListTreeModel;
    containerId: string;
    source: SessionListTreeDragSource;
}>): SessionListTreeRowMetadata[] {
    return Array.from(params.tree.rowMetadataById.values())
        .filter((metadata) =>
            metadata.containerId === params.containerId
            && metadata.kind !== 'workspace-root'
            && metadata.rowId !== params.source.id
            && canReorderSessionListSourceAroundTarget(params.source.metadata, metadata)
        )
        .sort((left, right) => left.itemIndex - right.itemIndex);
}

function buildReorderBeforeResult(target: SessionListTreeRowMetadata): TreeDropResult {
    return {
        instruction: {
            kind: 'reorder-before',
            targetId: target.rowId,
            containerId: target.containerId,
            parentId: target.parentRowId,
            depth: target.folderDepth,
        },
        visual: {
            kind: 'line',
            targetId: target.rowId,
            edge: 'top',
            depth: target.folderDepth,
        },
    };
}

function buildReorderAfterResult(target: SessionListTreeRowMetadata): TreeDropResult {
    return {
        instruction: {
            kind: 'reorder-after',
            targetId: target.rowId,
            containerId: target.containerId,
            parentId: target.parentRowId,
            depth: target.folderDepth,
        },
        visual: {
            kind: 'line',
            targetId: target.rowId,
            edge: 'bottom',
            depth: target.folderDepth,
        },
    };
}

function resolveFoldersFirstSessionBandResult(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    containerId: string;
}>): TreeDropResult | null {
    const children = orderedContainerChildren({
        tree: params.tree,
        containerId: params.containerId,
        source: params.source,
    });
    const firstSession = children.find((child) => child.kind === 'session') ?? null;
    if (firstSession) return buildReorderBeforeResult(firstSession);

    const folders = children.filter((child) => child.kind === 'folder');
    const lastFolder = folders[folders.length - 1] ?? null;
    return lastFolder ? buildReorderAfterResult(lastFolder) : null;
}

export function resolveSessionListFolderSortModeDropResult(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    result: TreeDropResult;
    folderSortMode: SessionListFolderSortMode;
}>): TreeDropResult {
    if (params.folderSortMode === 'mixed') return params.result;
    if (params.source.metadata.kind !== 'session') return params.result;

    const instruction = params.result.instruction;
    if (instruction.kind === 'reorder-before' || instruction.kind === 'reorder-after') {
        const target = params.tree.rowMetadataById.get(instruction.targetId) ?? null;
        if (target?.kind !== 'folder') return params.result;
        return resolveFoldersFirstSessionBandResult({
            tree: params.tree,
            source: params.source,
            containerId: instruction.containerId,
        }) ?? params.result;
    }

    if (instruction.kind === 'move-to-root' && instruction.placement === 'before-first') {
        return resolveFoldersFirstSessionBandResult({
            tree: params.tree,
            source: params.source,
            containerId: instruction.containerId,
        }) ?? params.result;
    }

    return params.result;
}
