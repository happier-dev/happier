import { SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP } from '@/sync/domains/session/listing/sessionListOrderingStateV1';

import type { SessionListTreeModel } from '../drop-resolution/sessionListTreeTypes';

type GroupOrderMap = Readonly<Record<string, ReadonlyArray<string> | undefined>>;

function dedupeOrderKeys(keys: ReadonlyArray<string>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const key of keys) {
        const normalized = typeof key === 'string' ? key.trim() : '';
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}

function insertOrderKey(params: Readonly<{
    keys: ReadonlyArray<string>;
    movedKey: string;
    beforeKey?: string | null;
    afterKey?: string | null;
}>): string[] {
    const withoutMoved = params.keys.filter((key) => key !== params.movedKey);
    if (params.beforeKey) {
        const beforeIndex = withoutMoved.indexOf(params.beforeKey);
        if (beforeIndex >= 0) {
            return [
                ...withoutMoved.slice(0, beforeIndex),
                params.movedKey,
                ...withoutMoved.slice(beforeIndex),
            ];
        }
    }
    if (params.afterKey) {
        const afterIndex = withoutMoved.indexOf(params.afterKey);
        if (afterIndex >= 0) {
            return [
                ...withoutMoved.slice(0, afterIndex + 1),
                params.movedKey,
                ...withoutMoved.slice(afterIndex + 1),
            ];
        }
    }
    return [params.movedKey, ...withoutMoved];
}

function copyOrderMapWithoutMovedKey(currentMap: GroupOrderMap, movedKey: string): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [groupKey, keys] of Object.entries(currentMap)) {
        if (!Array.isArray(keys)) continue;
        const nextKeys = keys.filter((key) => key !== movedKey);
        if (nextKeys.length > 0) out[groupKey] = nextKeys;
    }
    return out;
}

function collectDirectChildOrderKeys(tree: SessionListTreeModel, containerId: string): string[] {
    const keys: string[] = [];
    for (const metadata of tree.rowMetadataById.values()) {
        if (metadata.containerId !== containerId) continue;
        if (metadata.kind === 'workspace-root') continue;
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
}>): Record<string, string[]> | null {
    const moved = params.tree.rowMetadataById.get(params.movedRowId);
    const container = params.tree.containerMetadataById.get(params.containerId);
    if (!moved?.orderKey || !container?.groupKey) return null;

    const beforeKey = params.beforeRowId
        ? params.tree.rowMetadataById.get(params.beforeRowId)?.orderKey ?? null
        : null;
    const afterKey = params.afterRowId
        ? params.tree.rowMetadataById.get(params.afterRowId)?.orderKey ?? null
        : null;

    const currentMap = copyOrderMapWithoutMovedKey(params.currentMap, moved.orderKey);
    const directChildKeys = collectDirectChildOrderKeys(params.tree, params.containerId);
    const existingKeys = currentMap[container.groupKey] ?? [];
    const baseKeys = dedupeOrderKeys([...existingKeys, ...directChildKeys, moved.orderKey]);
    const nextKeys = insertOrderKey({
        keys: baseKeys,
        movedKey: moved.orderKey,
        beforeKey,
        afterKey,
    }).slice(0, SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP);

    return {
        ...currentMap,
        [container.groupKey]: nextKeys,
    };
}

export function applyGroupOrderUpdate(params: Readonly<{
    tree: SessionListTreeModel;
    currentMap: GroupOrderMap;
    movedRowId: string;
    containerId: string;
    beforeRowId?: string | null;
    afterRowId?: string | null;
    setSessionListGroupOrderV1: (next: Record<string, string[]>) => void;
}>): boolean {
    const next = buildSessionListGroupOrderAfterTreeDrop(params);
    if (!next) return false;
    params.setSessionListGroupOrderV1(next);
    return true;
}
