/**
 * The light server's SQLite write edge. The primary client reports each completed
 * write operation here, so maintenance that only matters after writes (WAL
 * checkpointing) is armed by writes instead of polling an idle database.
 */
const listeners = new Set<() => void>();

export function notifySqliteCommittedWrite(): void {
    for (const listener of listeners) listener();
}

export function onSqliteCommittedWrite(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
