export type LocalServicesSharedSubscriptionStoreOptions<TSnapshotClient, TWatchClient = never> = Readonly<{
    snapshotClient?: TSnapshotClient;
    watchClient?: TWatchClient;
    nowMs?: () => number;
}>;

export type LocalServicesSharedSubscriptionRefreshParams<TInput, TState, TSnapshotClient> = Readonly<{
    input: TInput;
    state: TState;
    snapshotClient: TSnapshotClient;
    nowMs: () => number;
    signal?: AbortSignal;
}>;

/**
 * One parked watch answer.
 *
 * `changed` carries the daemon's new snapshot; `idle` means the daemon's park window elapsed with
 * nothing to report and the store re-arms; `unavailable` retires the watch for this entry until a
 * user-initiated refresh or a foreground invalidation restarts it. There is deliberately no retry,
 * backoff or breaker here: the daemon owns the wait, so re-arming is rate-limited by its window,
 * and an unavailable watch degrades to the explicit refresh path rather than to a client timer.
 */
export type LocalServicesSharedSubscriptionWatchOutcome<TSnapshot> =
    | Readonly<{ status: 'changed'; snapshot: TSnapshot }>
    | Readonly<{ status: 'idle' }>
    | Readonly<{ status: 'unavailable' }>;

export type LocalServicesSharedSubscriptionWatchParams<TInput, TState, TWatchClient> = Readonly<{
    input: TInput;
    state: TState;
    watchClient: TWatchClient;
    nowMs: () => number;
    signal?: AbortSignal;
}>;

export type LocalServicesSharedSubscriptionStoreConfig<
    TInput,
    TState,
    TSnapshot,
    TSnapshotClient,
    TWatchClient = never,
> = Readonly<{
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
    /**
     * Whether a published snapshot actually covers a matching entry's scope.
     *
     * `matchesPublish` answers "could this publication affect this entry"; this answers "does the
     * payload it carried describe this entry". They differ for a domain whose entries are narrower
     * than a publication — a public-preview entry pinned to one `exposureId` is affected by a
     * session-wide publication but must not adopt a snapshot describing a different exposure. When
     * this returns false the entry refreshes instead of applying, so it converges on its own scope
     * rather than silently showing another scope's state. Omit it and every matching entry applies
     * the snapshot, which is right for a domain whose entries and publications share a scope.
     */
    snapshotCoversEntry?: (entryInput: TInput, snapshot: TSnapshot) => boolean;
    /**
     * Optional push half. While an entry has subscribers the store keeps exactly one watch
     * outstanding and re-arms it on every answer, so a domain that supplies this stays fresh
     * without any interval. Domains that do not supply it keep the pull-only lifecycle.
     */
    defaultWatchClient?: TWatchClient;
    watch?: (
        params: LocalServicesSharedSubscriptionWatchParams<TInput, TState, TWatchClient>,
    ) => Promise<LocalServicesSharedSubscriptionWatchOutcome<TSnapshot>>;
}>;

export type LocalServicesSharedSubscriptionStore<
    TInput,
    TState,
    TSnapshot,
    TSnapshotClient,
    TWatchClient = never,
> = Readonly<{
    getState(input: TInput): TState;
    subscribe(
        input: TInput,
        listener: () => void,
        options?: LocalServicesSharedSubscriptionStoreOptions<TSnapshotClient, TWatchClient>,
    ): () => void;
    invalidate(input: TInput): void;
    publish(input: TInput, snapshot: TSnapshot): void;
    reset(): void;
}>;

type SharedSubscriptionStoreEntry<TInput, TState, TSnapshotClient, TWatchClient> = {
    readonly input: TInput;
    state: TState;
    snapshotClient: TSnapshotClient;
    watchClient: TWatchClient;
    readonly listeners: Set<() => void>;
    refCount: number;
    inFlight: boolean;
    abortController: AbortController | null;
    watchAbortController: AbortController | null;
    watching: boolean;
    watchRetired: boolean;
    nowMs: () => number;
};

function notify<TInput, TState, TSnapshotClient, TWatchClient>(
    entry: SharedSubscriptionStoreEntry<TInput, TState, TSnapshotClient, TWatchClient>,
): void {
    for (const listener of entry.listeners) {
        listener();
    }
}

export function createLocalServicesSharedSubscriptionStore<
    TInput,
    TState,
    TSnapshot,
    TSnapshotClient,
    TWatchClient = never,
>(
    config: LocalServicesSharedSubscriptionStoreConfig<TInput, TState, TSnapshot, TSnapshotClient, TWatchClient>,
): LocalServicesSharedSubscriptionStore<TInput, TState, TSnapshot, TSnapshotClient, TWatchClient> {
    type Entry = SharedSubscriptionStoreEntry<TInput, TState, TSnapshotClient, TWatchClient>;
    const entries = new Map<string, Entry>();

    const setState = (
        entry: Entry,
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
        options?: LocalServicesSharedSubscriptionStoreOptions<TSnapshotClient, TWatchClient>,
    ): Entry => {
        let entry = entries.get(key);
        if (!entry) {
            entry = {
                input,
                state: config.createState(),
                snapshotClient: options?.snapshotClient ?? config.defaultSnapshotClient,
                watchClient: (options?.watchClient ?? config.defaultWatchClient) as TWatchClient,
                listeners: new Set(),
                refCount: 0,
                inFlight: false,
                abortController: null,
                watchAbortController: null,
                watching: false,
                watchRetired: false,
                nowMs: options?.nowMs ?? Date.now,
            };
            entries.set(key, entry);
        } else {
            if (options?.snapshotClient) {
                entry.snapshotClient = options.snapshotClient;
            }
            if (options?.watchClient) {
                entry.watchClient = options.watchClient;
            }
            if (options?.nowMs) {
                entry.nowMs = options.nowMs;
            }
        }
        return entry;
    };

    const runRefresh = async (
        entry: Entry,
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

    // The push half. Exactly one watch is outstanding per entry with subscribers; every answer
    // re-arms the next one, so the cadence is the daemon's park window and there is no timer here.
    // An unavailable watch retires until `invalidate` restarts it, which is what the user-visible
    // refresh control and the foreground trigger call.
    const runWatchLoop = (entry: Entry): void => {
        const watch = config.watch;
        if (!watch || entry.watching || entry.watchRetired || entry.refCount <= 0) {
            return;
        }
        entry.watching = true;
        const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
        entry.watchAbortController = abortController;
        void (async () => {
            try {
                const outcome = await watch({
                    input: entry.input,
                    state: entry.state,
                    watchClient: entry.watchClient,
                    nowMs: entry.nowMs,
                    ...(abortController ? { signal: abortController.signal } : {}),
                });
                if (abortController?.signal.aborted || entry.refCount <= 0) {
                    return;
                }
                if (outcome.status === 'unavailable') {
                    entry.watchRetired = true;
                    return;
                }
                if (outcome.status === 'changed') {
                    setState(entry, config.applySnapshot(entry.state, outcome.snapshot));
                }
            } catch {
                entry.watchRetired = true;
            } finally {
                entry.watching = false;
                if (entry.watchAbortController === abortController) {
                    entry.watchAbortController = null;
                }
            }
            runWatchLoop(entry);
        })();
    };

    const stopWatch = (entry: Entry): void => {
        entry.watchAbortController?.abort();
        entry.watchAbortController = null;
        entry.watching = false;
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
            runWatchLoop(entry);
            return () => {
                if (!subscribed) {
                    return;
                }
                subscribed = false;
                entry.listeners.delete(listener);
                entry.refCount -= 1;
                if (entry.refCount <= 0) {
                    entry.abortController?.abort();
                    stopWatch(entry);
                    entries.delete(key);
                }
            };
        },
        invalidate(input) {
            const normalized = config.normalizeInput(input);
            const entry = entries.get(config.storeKey(normalized));
            if (entry) {
                void runRefresh(entry);
                // A user-initiated refresh is also the recovery path for a retired watch.
                entry.watchRetired = false;
                runWatchLoop(entry);
            }
        },
        publish(input, snapshot) {
            const normalized = config.normalizeInput(input);
            const matchesPublish = config.matchesPublish;
            const snapshotCoversEntry = config.snapshotCoversEntry;
            for (const entry of entries.values()) {
                const matches = matchesPublish
                    ? matchesPublish(entry.input, input)
                    : config.storeKey(entry.input) === config.storeKey(normalized);
                if (!matches) {
                    continue;
                }
                if (snapshotCoversEntry && !snapshotCoversEntry(entry.input, snapshot)) {
                    void runRefresh(entry);
                    continue;
                }
                setState(entry, config.applySnapshot(entry.state, snapshot));
            }
        },
        reset() {
            for (const entry of entries.values()) {
                entry.abortController?.abort();
                stopWatch(entry);
            }
            entries.clear();
        },
    };
}
