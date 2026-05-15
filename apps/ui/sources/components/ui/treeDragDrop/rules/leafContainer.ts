import type { TreeRow } from '../treeDragDropTypes';

export function canTreeRowHaveChildren(row: TreeRow): boolean {
    return row.kind === 'container';
}
