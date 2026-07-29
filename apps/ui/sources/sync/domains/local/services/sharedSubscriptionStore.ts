export type LocalServicesSharedSubscriptionStoreOptions<TSnapshotClient> = Readonly<{
    snapshotClient?: TSnapshotClient;
    nowMs?: () => number;
}>;

export type LocalServicesSharedSubscriptionRefreshParams<TInput, TState, TSnapshotClient> = Readonly<{
    input: TInput;
    state: TState;
    snapshotClient: TSnapshotClient;
    nowMs: () => number;
    signal?: AbortSignal;
}>;

export type LocalServicesSharedSubscriptionStoreConfig<TInput, TState, TSnapshot, TSnapshotClient> = Readonly<{
    emptyState: TState;
    createState: () => TState;
    normalizeInput: (input: TInput) => TInput;
    storeKey: (input: TInput) => string;
    defaultSnapshotClient: TSnapshotClient;
    beginRefresh?: (state: TState, input: TInput, nowMs: () => number) => TState;
    refresh: (params: LocalServicesSharedSubscriptionRefreshParams<TInput, TState, TSnapshotClient>) => Promise<TState>;
    failRefresh?: (state: TState, input: TInput, nowMs: () => number, error: unknown) => TState;
    applySnapshot: (state: TState, snapshot: TSnapshot) => TState;
    matchesPublish?: (entryInput: TInput, publishInput: TInput) => boolean;
}>;

export type LocalServicesSharedSubscriptionStore<TInput, TState, TSnapshot, TSnapshotClient> = Readonly<{
    getState(input: TInput): TState;
    subscribe(
        input: TInput,
        listener: () => void,
        options?: LocalServicesSharedSubscriptionStoreOptions<TSnapshotClient>,
    ): () => void;
    invalidate(input: TInput): void;
    publish(input: TInput, snapshot: TSnapshot): void;
    reset(): void;
}>;

type SharedSubscriptionStoreEntry<TInput, TState, TSnapshotClient> = {
    readonly input: TInput;
    state: TState;
    snapshotClient: TSnapshotClient;
    readonly listeners: Set<() => void>;
    refCount: number;
    inFlight: boolean;
    abortController: AbortController | null;
    nowMs: () => number;
};

function notify<TInput, TState, TSnapshotClient>(
    entry: SharedSubscriptionStoreEntry<TInput, TState, TSnapshotClient>,
): void {
    for (const listener of entry.listeners) {
        listener();
    }
}

export function createLocalServicesSharedSubscriptionStore<TInput, TState, TSnapshot, TSnapshotClient>(
    config: LocalServicesSharedSubscriptionStoreConfig<TInput, TState, TSnapshot, TSnapshotClient>,
): LocalServicesSharedSubscriptionStore<TInput, TState, TSnapshot, TSnapshotClient> {
    const entries = new Map<string, SharedSubscriptionStoreEntry<TInput, TState, TSnapshotClient>>();

    const setState = (
        entry: SharedSubscriptionStoreEntry<TInput, TState, TSnapshotClient>,
        next: TState,
    ): void => {
        if (entry.state === next) {
            return;
        }
        entry.state = next;
        notify(entry);
    };

    const ensureEntry = (
        key: string,
        input: TInput,
        options?: LocalServicesSharedSubscriptionStoreOptions<TSnapshotClient>,
    ): SharedSubscriptionStoreEntry<TInput, TState, TSnapshotClient> => {
        let entry = entries.get(key);
        if (!entry) {
            entry = {
                input,
                state: config.createState(),
                snapshotClient: options?.snapshotClient ?? config.defaultSnapshotClient,
                listeners: new Set(),
                refCount: 0,
                inFlight: false,
                abortController: null,
                nowMs: options?.nowMs ?? Date.now,
            };
            entries.set(key, entry);
        } else {
            if (options?.snapshotClient) {
                entry.snapshotClient = options.snapshotClient;
            }
            if (options?.nowMs) {
                entry.nowMs = options.nowMs;
            }
        }
        return entry;
    };

    const runRefresh = async (
        entry: SharedSubscriptionStoreEntry<TInput, TState, TSnapshotClient>,
    ): Promise<void> => {
        if (entry.inFlight) {
            return;
        }
        entry.inFlight = true;
        const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
        entry.abortController = abortController;
        if (config.beginRefresh) {
            setState(entry, config.beginRefresh(entry.state, entry.input, entry.nowMs));
        }
        try {
            const next = await config.refresh({
                input: entry.input,
                state: entry.state,
                snapshotClient: entry.snapshotClient,
                nowMs: entry.nowMs,
                signal: abortController?.signal,
            });
            if (!abortController?.signal.aborted) {
                setState(entry, next);
            }
        } catch (error) {
            if (!abortController?.signal.aborted && config.failRefresh) {
                setState(entry, config.failRefresh(entry.state, entry.input, entry.nowMs, error));
            }
        } finally {
            entry.inFlight = false;
            if (entry.abortController === abortController) {
                entry.abortController = null;
            }
        }
    };

    return {
        getState(input) {
            const normalized = config.normalizeInput(input);
            return entries.get(config.storeKey(normalized))?.state ?? config.emptyState;
        },
        subscribe(input, listener, options) {
            const normalized = config.normalizeInput(input);
            const key = config.storeKey(normalized);
            const entry = ensureEntry(key, normalized, options);
            let subscribed = true;
            entry.listeners.add(listener);
            entry.refCount += 1;
            if (entry.refCount === 1) {
                void runRefresh(entry);
            }
            return () => {
                if (!subscribed) {
                    return;
                }
                subscribed = false;
                entry.listeners.delete(listener);
                entry.refCount -= 1;
                if (entry.refCount <= 0) {
                    entry.abortController?.abort();
                    entries.delete(key);
                }
            };
        },
        invalidate(input) {
            const normalized = config.normalizeInput(input);
            const entry = entries.get(config.storeKey(normalized));
            if (entry) {
                void runRefresh(entry);
            }
        },
        publish(input, snapshot) {
            const normalized = config.normalizeInput(input);
            const matchesPublish = config.matchesPublish;
            for (const entry of entries.values()) {
                const matches = matchesPublish
                    ? matchesPublish(entry.input, input)
                    : config.storeKey(entry.input) === config.storeKey(normalized);
                if (matches) {
                    setState(entry, config.applySnapshot(entry.state, snapshot));
                }
            }
        },
        reset() {
            for (const entry of entries.values()) {
                entry.abortController?.abort();
            }
            entries.clear();
        },
    };
}
