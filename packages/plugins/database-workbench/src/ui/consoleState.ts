export type ConsoleHistoryEntry = Readonly<{ sql: string }>;
export type ConsoleState = Readonly<{ sql: string; history: readonly ConsoleHistoryEntry[] }>;
/** Host-provided device storage, already scoped to Home/Account/Machine/target. */
export interface ConsoleDeviceStorage { read(): Promise<ConsoleState | null>; write(state: ConsoleState): Promise<void>; }
export function createConsoleState(storage: ConsoleDeviceStorage) {
    let state: ConsoleState = { sql: '', history: [] };
    const listeners = new Set<() => void>();
    type Change = (current: ConsoleState) => ConsoleState;
    let earlyChanges: Change[] | undefined = [];
    let hydration: Promise<ConsoleState> | undefined;
    let writes: Promise<ConsoleState> | undefined;
    function publish(next: ConsoleState) { state = next; for (const listener of listeners) listener(); }
    function initialize(): Promise<ConsoleState> {
        hydration ??= (async () => {
            const saved = await storage.read();
            const restored: ConsoleState = saved
                ? { sql: saved.sql, history: saved.history.map(({ sql }) => ({ sql })) }
                : { sql: '', history: [] };
            // Keep local interaction responsive while applying its intents to the saved base.
            if (saved) publish(earlyChanges!.reduce((current, change) => change(current), restored));
            earlyChanges = undefined;
            return restored;
        })();
        return hydration;
    }
    function commit(change: Change) {
        earlyChanges?.push(change);
        publish(change(state));
        const preceding = writes ?? initialize();
        const next = preceding.then(change);
        // Preserve intent order even when one device write fails; each caller sees its own failure.
        const write = next.then(value => storage.write(value));
        writes = write.then(() => next, () => next);
        // The returned write reports the failure; keep a failed read in the queue without an unhandled rejection.
        void writes.catch(() => {});
        return write;
    }
    function recordMany(entries: readonly ConsoleHistoryEntry[]) {
        const recorded = entries.map(({ sql }) => ({ sql }));
        return recorded.length ? commit(current => ({ ...current, history: [...current.history, ...recorded] })) : Promise.resolve();
    }
    return {
        get: () => state,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        async load() { await initialize(); },
        edit(sql: string) { return sql === state.sql && !earlyChanges ? Promise.resolve() : commit(current => ({ ...current, sql })); },
        record(entry: ConsoleHistoryEntry) { return recordMany([entry]); },
        recordMany,
        clearHistory() { return state.history.length || earlyChanges ? commit(current => ({ ...current, history: [] })) : Promise.resolve(); },
    };
}
