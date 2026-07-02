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

function copyOrderMapWithoutMovedKey(currentMap: OrderMap, movedKey: string): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [scopeKey, keys] of Object.entries(currentMap)) {
        if (!Array.isArray(keys)) continue;
        const nextKeys = keys.filter((key) => key !== movedKey);
        if (nextKeys.length > 0) out[scopeKey] = nextKeys;
    }
    return out;
}

/**
 * Builds the next scoped order array after moving `movedKey`.
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
    movedKey: string;
    directKeys: ReadonlyArray<string>;
    beforeKey?: string | null;
    afterKey?: string | null;
    maxKeys: number;
}>): Record<string, string[]> {
    const currentMap = copyOrderMapWithoutMovedKey(params.currentMap, params.movedKey);
    const existingKeys = currentMap[params.scopeKey] ?? [];
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

    return {
        ...currentMap,
        [params.scopeKey]: nextKeys,
    };
}
