import type { TreeDragSource, TreeRow } from '../treeDragDropTypes';

export function allowSameContainerReorder(
    _source: TreeDragSource,
    sourceRow: TreeRow | null,
    target: TreeRow,
): boolean {
    return !sourceRow || sourceRow.containerId === target.containerId;
}
