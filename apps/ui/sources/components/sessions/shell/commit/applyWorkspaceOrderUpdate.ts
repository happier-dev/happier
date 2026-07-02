import { SESSION_WORKSPACE_ORDER_MAX_KEYS_PER_SCOPE } from '@/sync/domains/session/listing/sessionWorkspaceOrderStateV1';

import type { SessionListTreeModel } from '../drop-resolution/sessionListTreeTypes';
import { buildOrderMapAfterMove } from './orderMapUpdate';

type WorkspaceOrderMap = Readonly<Record<string, ReadonlyArray<string> | undefined>>;

function collectWorkspaceOrderKeys(tree: SessionListTreeModel, containerId: string): string[] {
    const keys: string[] = [];
    for (const metadata of tree.rowMetadataById.values()) {
        if (metadata.containerId !== containerId) continue;
        if (metadata.kind !== 'workspace-root') continue;
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

    const beforeKey = params.beforeRowId
        ? params.tree.rowMetadataById.get(params.beforeRowId)?.orderKey ?? null
        : null;
    const afterKey = params.afterRowId
        ? params.tree.rowMetadataById.get(params.afterRowId)?.orderKey ?? null
        : null;

    const directWorkspaceKeys = collectWorkspaceOrderKeys(params.tree, params.containerId);
    return buildOrderMapAfterMove({
        currentMap: params.currentMap,
        scopeKey: container.groupKey,
        movedKey: moved.orderKey,
        directKeys: directWorkspaceKeys,
        beforeKey,
        afterKey,
        maxKeys: SESSION_WORKSPACE_ORDER_MAX_KEYS_PER_SCOPE,
    });
}

export function applyWorkspaceOrderUpdate(params: Readonly<{
    tree: SessionListTreeModel;
    currentMap: WorkspaceOrderMap;
    movedRowId: string;
    containerId: string;
    beforeRowId?: string | null;
    afterRowId?: string | null;
    setSessionWorkspaceOrderV1: (next: Record<string, string[]>) => void;
}>): boolean {
    const next = buildSessionWorkspaceOrderAfterTreeDrop(params);
    if (!next) return false;
    params.setSessionWorkspaceOrderV1(next);
    return true;
}
