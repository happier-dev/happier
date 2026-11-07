import { SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP } from '@/sync/domains/session/listing/sessionListOrderingStateV1';

import type { SessionListTreeModel } from '../drop-resolution/sessionListTreeTypes';
import { buildOrderMapAfterMove } from './orderMapUpdate';

type GroupOrderMap = Readonly<Record<string, ReadonlyArray<string> | undefined>>;
type OrderKeyFilter = (key: string) => boolean;

function collectDirectChildOrderKeys(
    tree: SessionListTreeModel,
    containerId: string,
    orderKeyFilter?: OrderKeyFilter,
): string[] {
    const keys: string[] = [];
    for (const metadata of tree.rowMetadataById.values()) {
        if (metadata.containerId !== containerId) continue;
        if (metadata.kind === 'workspace-root') continue;
        if (metadata.orderKey && (!orderKeyFilter || orderKeyFilter(metadata.orderKey))) {
            keys.push(metadata.orderKey);
        }
    }
    return keys;
}

function filterOrderKey(key: string | null, orderKeyFilter?: OrderKeyFilter): string | null {
    if (!key) return null;
    return !orderKeyFilter || orderKeyFilter(key) ? key : null;
}

function filterCurrentScopeOrderMap(params: Readonly<{
    currentMap: GroupOrderMap;
    scopeKey: string;
    orderKeyFilter?: OrderKeyFilter;
}>): GroupOrderMap {
    if (!params.orderKeyFilter) return params.currentMap;
    const currentKeys = params.currentMap[params.scopeKey];
    if (!Array.isArray(currentKeys)) return params.currentMap;
    const nextKeys = currentKeys.filter(params.orderKeyFilter);
    return {
        ...params.currentMap,
        [params.scopeKey]: nextKeys,
    };
}

function mergeFilteredScopeOrderMap(params: Readonly<{
    currentMap: GroupOrderMap;
    nextMap: Readonly<Record<string, string[]>>;
    scopeKey: string;
    orderKeyFilter: OrderKeyFilter;
}>): Record<string, string[]> {
    const currentScopeKeys = params.currentMap[params.scopeKey];
    if (!Array.isArray(currentScopeKeys) || currentScopeKeys.length === 0) {
        return { ...params.nextMap };
    }

    const nextFilteredKeys = (params.nextMap[params.scopeKey] ?? [])
        .filter(params.orderKeyFilter);
    const dedupedNextFilteredKeys = Array.from(new Set(nextFilteredKeys));
    const mergedScopeKeys: string[] = [];
    const mergedKeySet = new Set<string>();
    let nextFilteredIndex = 0;

    for (const currentKey of currentScopeKeys) {
        if (params.orderKeyFilter(currentKey)) {
            while (
                nextFilteredIndex < dedupedNextFilteredKeys.length
                && mergedKeySet.has(dedupedNextFilteredKeys[nextFilteredIndex] ?? '')
            ) {
                nextFilteredIndex += 1;
            }
            const replacementKey = dedupedNextFilteredKeys[nextFilteredIndex];
            nextFilteredIndex += 1;
            if (replacementKey && !mergedKeySet.has(replacementKey)) {
                mergedScopeKeys.push(replacementKey);
                mergedKeySet.add(replacementKey);
            }
            continue;
        }

        if (!mergedKeySet.has(currentKey)) {
            mergedScopeKeys.push(currentKey);
            mergedKeySet.add(currentKey);
        }
    }

    for (; nextFilteredIndex < dedupedNextFilteredKeys.length; nextFilteredIndex += 1) {
        const key = dedupedNextFilteredKeys[nextFilteredIndex];
        if (key && !mergedKeySet.has(key)) {
            mergedScopeKeys.push(key);
            mergedKeySet.add(key);
        }
    }

    return {
        ...params.nextMap,
        [params.scopeKey]: mergedScopeKeys,
    };
}

function resolveFilteredFallbackAnchor(params: Readonly<{
    directChildKeys: ReadonlyArray<string>;
    movedKey: string;
    beforeKey: string | null;
    afterKey: string | null;
    orderKeyFilter?: OrderKeyFilter;
}>): Readonly<{ beforeKey: string | null; afterKey: string | null }> {
    if (!params.orderKeyFilter || params.beforeKey || params.afterKey) {
        return { beforeKey: params.beforeKey, afterKey: params.afterKey };
    }
    const movedIndex = params.directChildKeys.indexOf(params.movedKey);
    if (movedIndex < 0) return { beforeKey: params.beforeKey, afterKey: params.afterKey };

    for (let index = movedIndex - 1; index >= 0; index -= 1) {
        const key = params.directChildKeys[index];
        if (key && key !== params.movedKey) return { beforeKey: null, afterKey: key };
    }
    for (let index = movedIndex + 1; index < params.directChildKeys.length; index += 1) {
        const key = params.directChildKeys[index];
        if (key && key !== params.movedKey) return { beforeKey: key, afterKey: null };
    }
    return { beforeKey: params.beforeKey, afterKey: params.afterKey };
}

export function buildSessionListGroupOrderAfterTreeDrop(params: Readonly<{
    tree: SessionListTreeModel;
    currentMap: GroupOrderMap;
    movedRowId: string;
    containerId: string;
    beforeRowId?: string | null;
    afterRowId?: string | null;
    orderKeyFilter?: OrderKeyFilter;
}>): Record<string, string[]> | null {
    const moved = params.tree.rowMetadataById.get(params.movedRowId);
    const container = params.tree.containerMetadataById.get(params.containerId);
    if (!moved?.orderKey || !container?.groupKey) return null;
    const movedKey = filterOrderKey(moved.orderKey, params.orderKeyFilter);
    if (!movedKey) return null;

    const beforeKey = filterOrderKey(
        params.beforeRowId
            ? params.tree.rowMetadataById.get(params.beforeRowId)?.orderKey ?? null
            : null,
        params.orderKeyFilter,
    );
    const afterKey = filterOrderKey(
        params.afterRowId
            ? params.tree.rowMetadataById.get(params.afterRowId)?.orderKey ?? null
            : null,
        params.orderKeyFilter,
    );

    const directChildKeys = collectDirectChildOrderKeys(params.tree, params.containerId, params.orderKeyFilter);
    const anchors = resolveFilteredFallbackAnchor({
        directChildKeys,
        movedKey,
        beforeKey,
        afterKey,
        orderKeyFilter: params.orderKeyFilter,
    });
    const filteredNext = buildOrderMapAfterMove({
        currentMap: filterCurrentScopeOrderMap({
            currentMap: params.currentMap,
            scopeKey: container.groupKey,
            orderKeyFilter: params.orderKeyFilter,
        }),
        scopeKey: container.groupKey,
        sourceScopeKey: moved.containerGroupKey,
        movedKey,
        directKeys: directChildKeys,
        beforeKey: anchors.beforeKey,
        afterKey: anchors.afterKey,
        maxKeys: SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP,
    });
    if (!params.orderKeyFilter) return filteredNext;
    return mergeFilteredScopeOrderMap({
        currentMap: params.currentMap,
        nextMap: filteredNext,
        scopeKey: container.groupKey,
        orderKeyFilter: params.orderKeyFilter,
    });
}

export function applyGroupOrderUpdate(params: Readonly<{
    tree: SessionListTreeModel;
    currentMap: GroupOrderMap;
    movedRowId: string;
    containerId: string;
    beforeRowId?: string | null;
    afterRowId?: string | null;
    orderKeyFilter?: OrderKeyFilter;
    setSessionListGroupOrderV1: (next: Record<string, string[]>) => void;
}>): boolean {
    const next = buildSessionListGroupOrderAfterTreeDrop(params);
    if (!next) return false;
    params.setSessionListGroupOrderV1(next);
    return true;
}
