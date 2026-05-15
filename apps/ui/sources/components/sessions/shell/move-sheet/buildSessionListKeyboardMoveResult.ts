import type { TreeDropResult } from '@/components/ui/treeDragDrop';

import type {
    SessionListTreeDragSource,
    SessionListTreeModel,
    SessionListTreeRowMetadata,
} from '../drop-resolution/sessionListTreeTypes';

export type SessionListKeyboardMoveDirection = 'up' | 'down';

export type BuildSessionListKeyboardMoveResultParams = Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    direction: SessionListKeyboardMoveDirection;
}>;

function buildBlockedResult(source: SessionListTreeDragSource): TreeDropResult {
    return {
        instruction: {
            kind: 'blocked',
            reason: 'same-position',
            hintTargetId: source.id,
        },
        visual: { kind: 'none' },
    };
}

function resolveOrderedSiblingRows(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
}>): SessionListTreeRowMetadata[] {
    return Array.from(params.tree.rowMetadataById.values())
        .filter((row) =>
            row.orderKey != null
            && row.containerId === params.source.metadata.containerId
            && row.parentRowId === params.source.metadata.parentRowId
        )
        .sort((a, b) => a.itemIndex - b.itemIndex);
}

export function buildSessionListKeyboardMoveResult(
    params: BuildSessionListKeyboardMoveResultParams,
): TreeDropResult {
    const siblings = resolveOrderedSiblingRows(params);
    const sourceIndex = siblings.findIndex((row) => row.rowId === params.source.id);
    if (sourceIndex < 0) return buildBlockedResult(params.source);

    const target = params.direction === 'up'
        ? siblings[sourceIndex - 1] ?? null
        : siblings[sourceIndex + 1] ?? null;
    if (!target) return buildBlockedResult(params.source);

    if (params.direction === 'up') {
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
