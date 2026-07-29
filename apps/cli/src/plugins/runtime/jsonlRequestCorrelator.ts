// CLI-private correlation primitive for host-owned JSON line transports.
export type JsonlRequestCorrelatorEntry<TResponse> = Readonly<{
    resolve: (response: TResponse) => void;
    reject: (error: Error) => void;
}>;

export type JsonlRequestCorrelator<TRequestId extends string, TResponse> = Readonly<{
    readonly size: number;
    add: (id: TRequestId, entry: JsonlRequestCorrelatorEntry<TResponse>) => () => boolean;
    resolve: (id: TRequestId, response: TResponse) => boolean;
    reject: (id: TRequestId, error: Error) => boolean;
    has: (id: TRequestId) => boolean;
    close: (error: Error) => void;
}>;

export function createJsonlRequestCorrelator<
    TRequestId extends string,
    TResponse,
>(): JsonlRequestCorrelator<TRequestId, TResponse> {
    const pendingEntries = new Map<TRequestId, JsonlRequestCorrelatorEntry<TResponse>>();
    let closeError: Error | undefined;

    const assertOpen = (): void => {
        if (closeError) throw closeError;
    };

    const removePendingEntry = (id: TRequestId): JsonlRequestCorrelatorEntry<TResponse> | undefined => {
        const entry = pendingEntries.get(id);
        if (!entry) return undefined;
        pendingEntries.delete(id);
        return entry;
    };

    return {
        get size() {
            return pendingEntries.size;
        },
        add(id, entry) {
            assertOpen();
            if (pendingEntries.has(id)) {
                throw new Error(`JSONL request id is already pending: ${id}`);
            }
            pendingEntries.set(id, entry);
            return () => pendingEntries.delete(id);
        },
        resolve(id, response) {
            const entry = removePendingEntry(id);
            if (!entry) return false;
            entry.resolve(response);
            return true;
        },
        reject(id, error) {
            const entry = removePendingEntry(id);
            if (!entry) return false;
            entry.reject(error);
            return true;
        },
        has(id) {
            return pendingEntries.has(id);
        },
        close(error) {
            if (closeError) return;
            closeError = error;
            const entries = [...pendingEntries.values()];
            pendingEntries.clear();
            let callbackError: unknown;
            for (const entry of entries) {
                try {
                    entry.reject(error);
                } catch (rejectError) {
                    callbackError ??= rejectError;
                }
            }
            if (callbackError) {
                throw callbackError;
            }
        },
    };
}
