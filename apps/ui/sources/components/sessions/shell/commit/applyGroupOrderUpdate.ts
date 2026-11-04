import type { SessionListTreeModel } from '../drop-resolution/sessionListTreeTypes';
import { buildOrderMapAfterMove } from './orderMapUpdate';

type GroupOrderMap = Readonly<Record<string, ReadonlyArray<string> | undefined>>;
export function collectDirectChildOrderKeys(
    tree: SessionListTreeModel,
    containerId: string,
): string[] {
    const keys = new Set<string>();
    for (const metadata of tree.rowMetadataById.values()) {
        if (metadata.containerId !== containerId) continue;
        if (metadata.kind !== 'session') continue;
        if (metadata.item.type === 'session' && metadata.item.supplementalAttention) continue;
        if (metadata.orderKey) keys.add(metadata.orderKey);
    }
    return [...keys];
}

export function buildSessionListGroupOrderAfterTreeDrop(params: Readonly<{
    tree: SessionListTreeModel;
    currentMap: GroupOrderMap;
    movedRowId: string;
    containerId: string;
    beforeRowId?: string | null;
    afterRowId?: string | null;
}>): Record<string, string[]> | null {
    const moved = params.tree.rowMetadataById.get(params.movedRowId);
    const container = params.tree.containerMetadataById.get(params.containerId);
    if (moved?.kind !== 'session' || !moved.orderKey || !container?.groupKey) return null;
    if (moved.item.type === 'session' && moved.item.supplementalAttention) return null;
    for (const rowId of [params.beforeRowId, params.afterRowId]) {
        const anchor = rowId ? params.tree.rowMetadataById.get(rowId)?.item : null;
        if (anchor?.type === 'session' && anchor.supplementalAttention) return null;
    }

    const beforeKey = params.beforeRowId
        ? (() => {
            const before = params.tree.rowMetadataById.get(params.beforeRowId);
            return before?.kind === 'session' && before.item.type === 'session' && !before.item.supplementalAttention ? before.orderKey : null;
        })()
        : null;
    const afterKey = params.afterRowId
        ? (() => {
            const after = params.tree.rowMetadataById.get(params.afterRowId);
            return after?.kind === 'session' && after.item.type === 'session' && !after.item.supplementalAttention ? after.orderKey : null;
        })()
        : null;

    const directChildKeys = collectDirectChildOrderKeys(params.tree, params.containerId);
    return buildOrderMapAfterMove({
        currentMap: params.currentMap,
        scopeKey: container.groupKey,
        movedKey: moved.orderKey,
        directKeys: directChildKeys,
        beforeKey,
        afterKey,
    });
}

export async function applyGroupOrderUpdate(params: Readonly<{
    tree: SessionListTreeModel;
    currentMap: GroupOrderMap;
    movedRowId: string;
    containerId: string;
    beforeRowId?: string | null;
    afterRowId?: string | null;
    setSessionListGroupOrderV1: (next: Record<string, string[]>) => Promise<void>;
}>): Promise<boolean> {
    const next = buildSessionListGroupOrderAfterTreeDrop(params);
    if (!next) return false;
    await params.setSessionListGroupOrderV1(next);
    return true;
}
