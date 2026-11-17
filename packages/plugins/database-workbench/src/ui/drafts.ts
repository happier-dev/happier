/** Row proposals stay in this workbench instance until an explicit successful settlement. */
export function createStagedEdits<T>() {
    const rows = new Map<string, T>();
    let snapshot: readonly T[] = [];
    const listeners = new Set<() => void>();
    const rowListeners = new Map<string, Set<() => void>>();
    const publish = (keys: readonly string[]) => {
        snapshot = [...rows.values()];
        for (const key of keys) for (const listener of rowListeners.get(key) ?? []) listener();
        for (const listener of listeners) listener();
    };
    return {
        subscribeRow(key: string, listener: () => void) {
            let subscriptions = rowListeners.get(key);
            if (!subscriptions) { subscriptions = new Set(); rowListeners.set(key, subscriptions); }
            subscriptions.add(listener);
            return () => { subscriptions.delete(listener); if (!subscriptions.size) rowListeners.delete(key); };
        },
        get: (key: string) => rows.get(key),
        stage(key: string, change: T) { if (rows.has(key) && Object.is(rows.get(key), change)) return; rows.set(key, change); publish([key]); },
        takeBack(key: string) { if (rows.delete(key)) publish([key]); },
        takeBackMany(keys: readonly string[]) { const removed = keys.filter(key => rows.delete(key)); if (removed.length) publish(removed); },
        discard() { if (rows.size) { const keys = [...rows.keys()]; rows.clear(); publish(keys); } },
        changes: () => snapshot,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
}
