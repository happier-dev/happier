import type { TreeContainerDropZone, TreeRow } from '../treeDragDropTypes';

export function computeReorderInstructionDepth(target: TreeRow): number {
    return Math.max(0, target.depth);
}

export function computeNestInstructionDepth(target: TreeRow | TreeContainerDropZone): number {
    return Math.max(0, target.depth);
}
