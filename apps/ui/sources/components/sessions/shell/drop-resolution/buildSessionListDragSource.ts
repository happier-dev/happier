import type { TreeRowKind } from '@/components/ui/treeDragDrop';

import type { SessionListTreeDragSource, SessionListTreeModel } from './sessionListTreeTypes';

function collectDescendantRowIds(params: Readonly<{
    tree: SessionListTreeModel;
    sourceRowId: string;
}>): Set<string> {
    const descendants = new Set<string>([params.sourceRowId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const metadata of params.tree.rowMetadataById.values()) {
            if (!metadata.parentRowId || descendants.has(metadata.rowId)) continue;
            if (descendants.has(metadata.parentRowId)) {
                descendants.add(metadata.rowId);
                changed = true;
            }
        }
    }
    return descendants;
}

export function buildSessionListDragSource(params: Readonly<{
    tree: SessionListTreeModel;
    sourceRowId: string;
}>): SessionListTreeDragSource {
    const metadata = params.tree.rowMetadataById.get(params.sourceRowId);
    if (!metadata) {
        throw new Error(`Unknown session list drag source: ${params.sourceRowId}`);
    }
    const kind: TreeRowKind = metadata.kind === 'session' ? 'leaf' : 'container';
    return {
        id: metadata.rowId,
        kind,
        excludedDescendantIds: kind === 'container'
            ? collectDescendantRowIds(params)
            : new Set([metadata.rowId]),
        metadata,
    };
}
