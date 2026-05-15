import type { TreeRow } from '../treeDragDropTypes';

export function buildExcludedDescendantIds(rows: ReadonlyArray<TreeRow>, sourceId: string): ReadonlySet<string> {
    const excluded = new Set<string>([sourceId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const row of rows) {
            if (row.parentId && excluded.has(row.parentId) && !excluded.has(row.id)) {
                excluded.add(row.id);
                changed = true;
            }
        }
    }
    return excluded;
}

export function isExcludedDescendant(sourceExcludedIds: ReadonlySet<string>, targetId: string): boolean {
    return sourceExcludedIds.has(targetId);
}
