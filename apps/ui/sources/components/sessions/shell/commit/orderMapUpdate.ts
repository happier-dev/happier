type OrderMap = Readonly<Record<string, ReadonlyArray<string> | undefined>>;

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

function sameOrder(current: readonly string[], next: readonly string[]): boolean {
    return current.length === next.length && current.every((key, index) => key === next[index]);
}

/**
 * Builds a patch containing only the changed scopes after moving `movedKey`.
 *
 * The LATEST current-map order is the baseline (it carries the user's most
 * recent intent, including background reorders). `directKeys` is the set of
 * keys currently present in the (latest) tree scope; it only contributes keys
 * that are NOT already in the current map — newly visible siblings — appended
 * after the current-map entries. It must never re-order keys the current map
 * already places, otherwise a stale tree snapshot could bias concurrent order.
 *
 * See `.project/plans/session-list-drag-geometry-performance-unification.md`
 * sections 1.5 and 3.5: "latest current-map order is the baseline, not stale
 * snapshot direct keys".
 */
export function buildOrderMapAfterMove(params: Readonly<{
    currentMap: OrderMap;
    scopeKey: string;
    sourceScopeKey?: string | null;
    orderKeyFilter?: (key: string) => boolean;
    mergeDestinationKeys?: (keys: string[]) => string[];
    movedKey: string;
    directKeys: ReadonlyArray<string>;
    beforeKey?: string | null;
    afterKey?: string | null;
    maxKeys: number;
}>): Record<string, string[]> {
    const currentKeys = params.currentMap[params.scopeKey] ?? [];
    const existingKeys = params.orderKeyFilter ? currentKeys.filter(params.orderKeyFilter) : currentKeys;
    const existingKeySet = new Set(dedupeOrderKeys(existingKeys));
    const newlyVisibleKeys = dedupeOrderKeys(params.directKeys)
        .filter((key) => key !== params.movedKey && !existingKeySet.has(key));
    const baseKeys = dedupeOrderKeys([...existingKeys, ...newlyVisibleKeys, params.movedKey]);
    const nextKeys = insertOrderKey({
        keys: baseKeys,
        movedKey: params.movedKey,
        beforeKey: params.beforeKey,
        afterKey: params.afterKey,
    }).slice(0, params.maxKeys);

    const destinationKeys = params.mergeDestinationKeys?.(nextKeys) ?? nextKeys;
    const changes: Record<string, string[]> = {};
    if (!sameOrder(currentKeys, destinationKeys)) changes[params.scopeKey] = destinationKeys;
    if (params.sourceScopeKey && params.sourceScopeKey !== params.scopeKey) {
        const sourceKeys = params.currentMap[params.sourceScopeKey];
        if (sourceKeys?.includes(params.movedKey)) {
            changes[params.sourceScopeKey] = sourceKeys.filter((key) => key !== params.movedKey);
        }
    }
    return changes;
}
