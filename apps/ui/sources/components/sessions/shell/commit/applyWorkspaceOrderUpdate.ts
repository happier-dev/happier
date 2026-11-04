import type { SessionListTreeModel } from '../drop-resolution/sessionListTreeTypes';
import { buildOrderMapAfterMove } from './orderMapUpdate';

type WorkspaceOrderMap = Readonly<Record<string, ReadonlyArray<string> | undefined>>;

function collectWorkspaceOrderKeys(tree: SessionListTreeModel, containerId: string): string[] {
    const supplementalGroups = new Set<string | undefined>();
    const ordinaryGroups = new Set<string | undefined>();
    for (const item of tree.items) {
        if (item.type === 'header') continue;
        (item.type === 'session' && item.supplementalAttention ? supplementalGroups : ordinaryGroups).add(item.groupKey);
    }
    const keys: string[] = [];
    for (const metadata of tree.rowMetadataById.values()) {
        if (metadata.containerId !== containerId) continue;
        if (metadata.kind !== 'workspace-root') continue;
        const groupKey = metadata.item.groupKey;
        if (supplementalGroups.has(groupKey) && !ordinaryGroups.has(groupKey)) continue;
        if (metadata.orderKey) keys.push(metadata.orderKey);
    }
    return keys;
}

export function buildSessionWorkspaceOrderAfterTreeDrop(params: Readonly<{
    tree: SessionListTreeModel;
    currentMap: WorkspaceOrderMap;
    movedRowId: string;
    containerId: string;
    beforeRowId?: string | null;
    afterRowId?: string | null;
}>): Record<string, string[]> | null {
    const moved = params.tree.rowMetadataById.get(params.movedRowId);
    const container = params.tree.containerMetadataById.get(params.containerId);
    if (moved?.kind !== 'workspace-root' || !moved.orderKey) return null;
    if (container?.kind !== 'workspace-order' || !container.groupKey) return null;
    const directWorkspaceKeys = collectWorkspaceOrderKeys(params.tree, params.containerId);
    if (!directWorkspaceKeys.includes(moved.orderKey)) return null;
    const ordinaryWorkspaceKeys = new Set(directWorkspaceKeys);

    const beforeKey = params.beforeRowId
        ? params.tree.rowMetadataById.get(params.beforeRowId)?.orderKey ?? null
        : null;
    const afterKey = params.afterRowId
        ? params.tree.rowMetadataById.get(params.afterRowId)?.orderKey ?? null
        : null;
    if ((beforeKey && !ordinaryWorkspaceKeys.has(beforeKey)) || (afterKey && !ordinaryWorkspaceKeys.has(afterKey))) return null;

    return buildOrderMapAfterMove({
        currentMap: params.currentMap,
        scopeKey: container.groupKey,
        movedKey: moved.orderKey,
        directKeys: directWorkspaceKeys,
        beforeKey,
        afterKey,
    });
}

export async function applyWorkspaceOrderUpdate(params: Readonly<{
    tree: SessionListTreeModel;
    currentMap: WorkspaceOrderMap;
    movedRowId: string;
    containerId: string;
    beforeRowId?: string | null;
    afterRowId?: string | null;
    setSessionWorkspaceOrderV1: (next: Record<string, string[]>) => Promise<void>;
}>): Promise<boolean> {
    const next = buildSessionWorkspaceOrderAfterTreeDrop(params);
    if (!next) return false;
    await params.setSessionWorkspaceOrderV1(next);
    return true;
}
