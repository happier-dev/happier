import { SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP } from '@/sync/domains/session/listing/sessionListOrderingStateV1';

import type { SessionListTreeModel } from '../drop-resolution/sessionListTreeTypes';
import { buildOrderMapAfterMove } from './orderMapUpdate';

type GroupOrderMap = Readonly<Record<string, ReadonlyArray<string> | undefined>>;
export type SessionListGroupOrderChildKind = 'sessionsOnly' | 'foldersOnly' | 'mixed';

function shouldIncludeOrderKey(
    kind: SessionListGroupOrderChildKind,
    rowKind: string,
): boolean {
    if (kind === 'mixed') return true;
    if (kind === 'sessionsOnly') return rowKind === 'session';
    return rowKind === 'folder';
}

function collectDirectChildOrderKeys(
    tree: SessionListTreeModel,
    containerId: string,
    childKind: SessionListGroupOrderChildKind,
): string[] {
    const keys: string[] = [];
    for (const metadata of tree.rowMetadataById.values()) {
        if (metadata.containerId !== containerId) continue;
        if (metadata.kind === 'workspace-root') continue;
        if (!shouldIncludeOrderKey(childKind, metadata.kind)) continue;
        if (metadata.orderKey) keys.push(metadata.orderKey);
    }
    return keys;
}

export function buildSessionListGroupOrderAfterTreeDrop(params: Readonly<{
    tree: SessionListTreeModel;
    currentMap: GroupOrderMap;
    movedRowId: string;
    containerId: string;
    beforeRowId?: string | null;
    afterRowId?: string | null;
    childKind?: SessionListGroupOrderChildKind;
}>): Record<string, string[]> | null {
    const moved = params.tree.rowMetadataById.get(params.movedRowId);
    const container = params.tree.containerMetadataById.get(params.containerId);
    if (!moved?.orderKey || !container?.groupKey) return null;
    const childKind = params.childKind ?? 'mixed';

    const beforeKey = params.beforeRowId
        ? (() => {
            const before = params.tree.rowMetadataById.get(params.beforeRowId);
            return before && shouldIncludeOrderKey(childKind, before.kind) ? before.orderKey : null;
        })()
        : null;
    const afterKey = params.afterRowId
        ? (() => {
            const after = params.tree.rowMetadataById.get(params.afterRowId);
            return after && shouldIncludeOrderKey(childKind, after.kind) ? after.orderKey : null;
        })()
        : null;

    const directChildKeys = collectDirectChildOrderKeys(params.tree, params.containerId, childKind);
    const allowedKeys = new Set([...directChildKeys, moved.orderKey]);
    const nextMap = buildOrderMapAfterMove({
        currentMap: params.currentMap,
        scopeKey: container.groupKey,
        movedKey: moved.orderKey,
        directKeys: directChildKeys,
        beforeKey,
        afterKey,
        maxKeys: SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP,
    });
    return {
        ...nextMap,
        [container.groupKey]: (nextMap[container.groupKey] ?? []).filter((key) => allowedKeys.has(key)),
    };
}

export function applyGroupOrderUpdate(params: Readonly<{
    tree: SessionListTreeModel;
    currentMap: GroupOrderMap;
    movedRowId: string;
    containerId: string;
    beforeRowId?: string | null;
    afterRowId?: string | null;
    childKind?: SessionListGroupOrderChildKind;
    setSessionListGroupOrderV1: (next: Record<string, string[]>) => void;
}>): boolean {
    const next = buildSessionListGroupOrderAfterTreeDrop(params);
    if (!next) return false;
    params.setSessionListGroupOrderV1(next);
    return true;
}
