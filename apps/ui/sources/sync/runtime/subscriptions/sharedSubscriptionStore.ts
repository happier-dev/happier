export type SharedSubscriptionStoreOptions<TSnapshotClient, TWatchClient = never> = Readonly<{
    snapshotClient?: TSnapshotClient;
    watchClient?: TWatchClient;
    nowMs?: () => number;
}>;

export type SharedSubscriptionReadAcquisition = Readonly<{ readOnce(): Promise<void>; dispose(): void }>;

type SharedSubscriptionStateUpdate<TState> = (current: TState) => TState;

function isStateUpdate<TState>(value: TState | SharedSubscriptionStateUpdate<TState>): value is SharedSubscriptionStateUpdate<TState> {
    return typeof value === 'function';
}

type AcquiredRead = {
    refCount: number;
    controller: AbortController;
    read: Promise<void> | null;
};

export type SharedSubscriptionRefreshParams<TInput, TState, TSnapshotClient> = Readonly<{
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
 * nothing to report. `retry` means the transport exhausted that watch's deadline without an
 * answer. Both re-arm with the same cursor; the daemon window or transport deadline owns the
 * cadence, without a client timer. `unavailable` retires the watch until a user refresh, fresh
 * publication, foreground invalidation or a subscribed transport recovery restarts it.
 */
export type SharedSubscriptionWatchOutcome<TSnapshot> =
    | Readonly<{ status: 'changed'; snapshot: TSnapshot }>
    | Readonly<{ status: 'idle' }>
    | Readonly<{ status: 'retry' }>
    | Readonly<{ status: 'unavailable' }>;

/**
 * Async transport preparation may finish after the watch client returns its reply promise.
 * `dispatched` also resolves on pre-dispatch failure/cancellation so publication cannot hang.
 */
export type SharedSubscriptionWatchRequest<TSnapshot> = Readonly<{
    dispatched: Promise<void>;
    outcome: Promise<SharedSubscriptionWatchOutcome<TSnapshot>>;
}>;

export type SharedSubscriptionWatchParams<TInput, TState, TWatchClient> = Readonly<{
    input: TInput;
    state: TState;
    watchClient: TWatchClient;
    nowMs: () => number;
    signal?: AbortSignal;
}>;

export type SharedSubscriptionStoreConfig<
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
    /** Keep last-known state after the last demand leaves, until its owner retires it. */
    retainState?: boolean;
    /** Resource retirement is distinct from a consumer closing; retained entries own this listener. */
    subscribeRetirement?: (input: TInput, retire: () => void) => () => void;
    shouldRefresh?: (state: TState) => boolean;
    shouldWatch?: (state: TState) => boolean;
    /** Seed the watch cursor from the immediate read before parking. */
    watchAfterRefresh?: boolean;
    beginRefresh?: (state: TState, input: TInput, nowMs: () => number) => TState;
    /** State-dependent reconciliation runs synchronously against current state at commit. */
    refresh: (params: SharedSubscriptionRefreshParams<TInput, TState, TSnapshotClient>) => Promise<TState | SharedSubscriptionStateUpdate<TState>>;
    failRefresh?: (state: TState, input: TInput, nowMs: () => number, error: unknown) => TState;
    /** Retain useful content while exposing the loss of live observation. */
    failWatch?: (state: TState, input: TInput) => TState;
    /** Authenticated reconnect requests revalidation; ordinary reachability wakes only renew failed observation. */
    subscribeRecovery?: (input: TInput, recover: (revalidate?: boolean) => void) => () => void;
    applySnapshot: (state: TState, snapshot: TSnapshot) => TState;
    /** Publish derived/sibling state only after the next watch has dispatched. */
    onWatchSnapshot?: (input: TInput, snapshot: TSnapshot, previous: TState) => void;
    matchesPublish?: (entryInput: TInput, publishInput: TInput) => boolean;
    /**
     * Whether a published snapshot actually covers a matching entry's scope.
     *
     * `matchesPublish` answers "could this publication affect this entry"; this answers "does the
     * payload it carried describe this entry". They differ for a domain whose entries are narrower
     * than a publication — a public-preview entry pinned to one `exposureId` is affected by a
     * session-wide publication but must not adopt a snapshot describing a different exposure. When
     * this returns false a demanded entry refreshes instead of applying, so it converges on its own
     * scope rather than silently showing another scope's state. A retained closed entry revalidates
     * when demand returns. Omit it and every matching entry applies
     * the snapshot, which is right for a domain whose entries and publications share a scope.
     */
    snapshotCoversEntry?: (entryInput: TInput, snapshot: TSnapshot, publishInput: TInput) => boolean;
    /**
     * Optional push half. While an entry has subscribers the store keeps exactly one watch
     * outstanding and re-arms it on every answer, so a domain that supplies this stays fresh
     * without any interval. Domains that do not supply it keep the pull-only lifecycle.
     */
    defaultWatchClient?: TWatchClient;
    /** Optional cancellation-owned producer demand spanning the entire series of watch replies. */
    observeWatch?: (params: SharedSubscriptionWatchParams<TInput, TState, TWatchClient>) => Promise<void>;
    watch?: (
        params: SharedSubscriptionWatchParams<TInput, TState, TWatchClient>,
    ) => Promise<SharedSubscriptionWatchOutcome<TSnapshot>> | SharedSubscriptionWatchRequest<TSnapshot>;
}>;

export type SharedSubscriptionStore<
    TInput,
    TState,
    TSnapshot,
    TSnapshotClient,
    TWatchClient = never,
> = Readonly<{
    getState(input: TInput): TState;
    observe(input: TInput, listener: () => void): () => void;
    /** Refresh activity is separate from the retained domain snapshot. */
    isRefreshing(input: TInput): boolean;
    observeRefreshing(input: TInput, listener: () => void): () => void;
    read(input: TInput, options?: SharedSubscriptionStoreOptions<TSnapshotClient, TWatchClient>): Promise<void>;
    readOnce(input: TInput, options?: SharedSubscriptionStoreOptions<TSnapshotClient, TWatchClient>): Promise<void>;
    /** A mounted caller lifetime shares one passive read without acquiring refresh/watch demand. */
    acquireReadOnce(input: TInput, ownerId: string, read: (signal: AbortSignal) => Promise<void>): SharedSubscriptionReadAcquisition;
    subscribe(
        input: TInput,
        listener: () => void,
        options?: SharedSubscriptionStoreOptions<TSnapshotClient, TWatchClient>,
    ): () => void;
    invalidate(input: TInput): void;
    publish(input: TInput, snapshot: TSnapshot, options?: Readonly<{ resumeWatch?: boolean }>): void;
    reset(): void;
}>;

type SharedSubscriptionStoreEntry<TInput, TState, TSnapshotClient, TWatchClient> = {
    readonly input: TInput;
    state: TState;
    snapshotClient: TSnapshotClient;
    watchClient: TWatchClient;
    readonly listeners: Set<() => void>;
    readonly refreshListeners: Set<() => void>;
    readonly acquiredReads: Map<string, AcquiredRead>;
    refreshing: boolean;
    refCount: number;
    inFlight: Promise<void> | null;
    refreshRequested: boolean;
    readStarted: boolean;
    abortController: AbortController | null;
    watchAbortController: AbortController | null;
    observationAbortController: AbortController | null;
    watching: boolean;
    watchRetired: boolean;
    watchRecoveryRequested: boolean;
    watchRecoveryNeedsRefresh: boolean;
    unsubscribeRecovery: (() => void) | null;
    unsubscribeRetirement: (() => void) | null;
    nowMs: () => number;
};

function notify<TInput, TState, TSnapshotClient, TWatchClient>(
    entry: SharedSubscriptionStoreEntry<TInput, TState, TSnapshotClient, TWatchClient>,
): void {
    for (const listener of entry.listeners) {
        listener();
    }
}

export function createSharedSubscriptionStore<
    TInput,
    TState,
    TSnapshot,
    TSnapshotClient,
    TWatchClient = never,
>(
    config: SharedSubscriptionStoreConfig<TInput, TState, TSnapshot, TSnapshotClient, TWatchClient>,
): SharedSubscriptionStore<TInput, TState, TSnapshot, TSnapshotClient, TWatchClient> {
    type Entry = SharedSubscriptionStoreEntry<TInput, TState, TSnapshotClient, TWatchClient>;
    const entries = new Map<string, Entry>();

    const setRefreshing = (entry: Entry, refreshing: boolean): void => {
        if (entry.refreshing === refreshing) return;
        entry.refreshing = refreshing;
        for (const listener of entry.refreshListeners) listener();
    };

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
        options?: SharedSubscriptionStoreOptions<TSnapshotClient, TWatchClient>,
    ): Entry => {
        let entry = entries.get(key);
        if (!entry) {
            entry = {
                input,
                state: config.createState(),
                snapshotClient: options?.snapshotClient ?? config.defaultSnapshotClient,
                watchClient: (options?.watchClient ?? config.defaultWatchClient) as TWatchClient,
                listeners: new Set(),
                refreshListeners: new Set(),
                acquiredReads: new Map(),
                refreshing: false,
                refCount: 0,
                inFlight: null,
                refreshRequested: false,
                readStarted: false,
                abortController: null,
                watchAbortController: null,
                observationAbortController: null,
                watching: false,
                watchRetired: false,
                watchRecoveryRequested: false,
                watchRecoveryNeedsRefresh: false,
                unsubscribeRecovery: null,
                unsubscribeRetirement: null,
                nowMs: options?.nowMs ?? Date.now,
            };
            entries.set(key, entry);
            const created = entry;
            const unsubscribeRetirement = config.subscribeRetirement?.(created.input, () => retireEntry(key, created)) ?? null;
            if (entries.get(key) === created) created.unsubscribeRetirement = unsubscribeRetirement;
            else unsubscribeRetirement?.();
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

    const runRefresh = (
        entry: Entry,
    ): Promise<void> => {
        if (entry.inFlight) return entry.inFlight;
        if (config.shouldRefresh?.(entry.state) === false) return Promise.resolve();
        entry.refreshRequested = false;
        entry.readStarted = true;
        const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
        entry.abortController = abortController;
        setRefreshing(entry, true);
        if (config.beginRefresh) {
            setState(entry, config.beginRefresh(entry.state, entry.input, entry.nowMs));
        }
        const promise = (async () => { try {
            const state = entry.state;
            const next = await config.refresh({
                input: entry.input,
                state,
                snapshotClient: entry.snapshotClient,
                nowMs: entry.nowMs,
                signal: abortController?.signal,
            });
            if (!abortController?.signal.aborted) {
                setState(entry, isStateUpdate(next) ? next(entry.state) : next);
            }
        } catch (error) {
            if (!abortController?.signal.aborted && config.failRefresh) {
                setState(entry, config.failRefresh(entry.state, entry.input, entry.nowMs, error));
            }
        } finally {
            entry.inFlight = null;
            if (entry.abortController === abortController) {
                entry.abortController = null;
            }
            setRefreshing(entry, false);
            // A mutation or source update during this read must not be swallowed by
            // single-flight sharing. Coalesce those invalidations into one subsequent read.
            if (entry.refreshRequested && entry.refCount > 0 && !abortController?.signal.aborted) {
                const refresh = runRefresh(entry);
                if (config.watchAfterRefresh) void refresh.then(() => runWatchLoop(entry));
            } else if (config.watchAfterRefresh && !abortController?.signal.aborted) {
                // Direct reads also own the wake if an old watch answered while
                // they were pending; there may be no subscribe/invalidate waiter.
                void runWatchLoop(entry);
            }
        } })();
        entry.inFlight = promise;
        return promise;
    };

    // The push half shares one value-watch series per subscribed entry. Answers re-arm
    // that series within its optional observation lifetime, without a renewal timer.
    // An unavailable watch retires until invalidation, publication or transport recovery.
    const retireWatch = (entry: Entry): void => {
        entry.watchRetired = !entry.watchRecoveryRequested;
        if (entry.watchRetired) stopWatch(entry);
        if (entry.watchRetired && config.failWatch) setState(entry, config.failWatch(entry.state, entry.input));
    };
    const runWatchLoop = (entry: Entry): Promise<void> => {
        const watch = config.watch;
        // A coalesced recovery read may already have started when the previous
        // read's waiter resumes. Seed the watch from that current read's cursor.
        if (!watch || entry.watching || entry.watchRetired || entry.refCount <= 0
            || (config.watchAfterRefresh && entry.inFlight !== null) || config.shouldWatch?.(entry.state) === false) {
            return Promise.resolve();
        }
        entry.watching = true;
        entry.watchRecoveryRequested = false;
        entry.watchRecoveryNeedsRefresh = false;
        if (config.observeWatch && !entry.observationAbortController && typeof AbortController !== 'undefined') {
            const observationController = new AbortController();
            entry.observationAbortController = observationController;
            const observationEnded = () => {
                if (observationController.signal.aborted || entry.observationAbortController !== observationController) return;
                retireWatch(entry);
                // A recovery that preceded the old transport's terminal reply renews once.
                if (!entry.watchRetired) {
                    stopWatch(entry);
                    void runWatchLoop(entry);
                }
            };
            void config.observeWatch({ input: entry.input, state: entry.state, watchClient: entry.watchClient,
                nowMs: entry.nowMs, signal: observationController.signal }).then(observationEnded, observationEnded);
        }
        const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
        entry.watchAbortController = abortController;
        let dispatched = Promise.resolve();
        void (async () => {
            let publication: { snapshot: TSnapshot; previous: TState; changed: boolean } | undefined;
            try {
                const request = watch({
                    input: entry.input,
                    state: entry.state,
                    watchClient: entry.watchClient,
                    nowMs: entry.nowMs,
                    ...(abortController ? { signal: abortController.signal } : {}),
                });
                if ('outcome' in request) dispatched = request.dispatched;
                const outcome = await ('outcome' in request ? request.outcome : request);
                if (abortController?.signal.aborted || entry.refCount <= 0) {
                    return;
                }
                if (outcome.status === 'unavailable') {
                    retireWatch(entry);
                }
                if (outcome.status === 'changed') {
                    const previous = entry.state;
                    const next = config.applySnapshot(previous, outcome.snapshot);
                    entry.state = next;
                    publication = { snapshot: outcome.snapshot, previous, changed: previous !== next };
                }
            } catch {
                if (!abortController?.signal.aborted) retireWatch(entry);
            } finally {
                if (entry.watchAbortController === abortController) {
                    entry.watching = false;
                    entry.watchAbortController = null;
                }
            }
            if (!abortController?.signal.aborted) {
                // A reconnect may arrive before the old request's failure. Re-read
                // when that reply cannot seed another watch, preserving the wake.
                if (entry.watchRecoveryNeedsRefresh && config.shouldWatch?.(entry.state) === false) {
                    await runRefresh(entry);
                }
                // Install the new cursor before re-arming, then let transport preparation reach
                // dispatch before synchronous subscribers (including React) can occupy the thread.
                await runWatchLoop(entry);
                if (publication && !abortController?.signal.aborted && entry.refCount > 0) {
                    config.onWatchSnapshot?.(entry.input, publication.snapshot, publication.previous);
                    if (publication.changed) notify(entry);
                }
            }
        })();
        return dispatched;
    };

    const stopWatch = (entry: Entry): void => {
        entry.observationAbortController?.abort();
        entry.observationAbortController = null;
        entry.watchAbortController?.abort();
        entry.watchAbortController = null;
        entry.watching = false;
    };

    const retireEntry = (key: string, entry: Entry): void => {
        // A late callback belongs to the entry that registered it, never a replacement.
        if (entries.get(key) !== entry) return;
        entries.delete(key);
        entry.refCount = 0;
        entry.refreshRequested = false;
        entry.unsubscribeRecovery?.();
        entry.unsubscribeRecovery = null;
        entry.unsubscribeRetirement?.();
        entry.unsubscribeRetirement = null;
        entry.abortController?.abort();
        for (const read of entry.acquiredReads.values()) read.controller.abort();
        entry.acquiredReads.clear();
        stopWatch(entry);
        setState(entry, config.emptyState);
        setRefreshing(entry, false);
        entry.listeners.clear();
        entry.refreshListeners.clear();
    };

    return {
        getState(input) {
            const normalized = config.normalizeInput(input);
            return entries.get(config.storeKey(normalized))?.state ?? config.emptyState;
        },
        observe(input, listener) {
            const normalized = config.normalizeInput(input);
            const entry = ensureEntry(config.storeKey(normalized), normalized);
            entry.listeners.add(listener);
            return () => { entry.listeners.delete(listener); };
        },
        isRefreshing(input) {
            const normalized = config.normalizeInput(input);
            return entries.get(config.storeKey(normalized))?.refreshing ?? false;
        },
        observeRefreshing(input, listener) {
            const normalized = config.normalizeInput(input);
            const entry = ensureEntry(config.storeKey(normalized), normalized);
            entry.refreshListeners.add(listener);
            return () => { entry.refreshListeners.delete(listener); };
        },
        read(input, options) {
            const normalized = config.normalizeInput(input);
            return runRefresh(ensureEntry(config.storeKey(normalized), normalized, options));
        },
        readOnce(input, options) {
            const normalized = config.normalizeInput(input);
            const entry = ensureEntry(config.storeKey(normalized), normalized, options);
            return entry.inFlight ?? (entry.readStarted ? Promise.resolve() : runRefresh(entry));
        },
        acquireReadOnce(input, ownerId, read) {
            const normalized = config.normalizeInput(input);
            const key = config.storeKey(normalized);
            const entry = ensureEntry(key, normalized);
            let acquired = entry.acquiredReads.get(ownerId);
            if (!acquired) {
                acquired = { refCount: 0, controller: new AbortController(), read: null };
                entry.acquiredReads.set(ownerId, acquired);
            }
            const shared = acquired;
            shared.refCount += 1;
            let disposed = false;
            return {
                readOnce() {
                    if (disposed || shared.controller.signal.aborted) return Promise.resolve();
                    if (!shared.read) shared.read = read(shared.controller.signal);
                    return shared.read;
                },
                dispose() {
                    if (disposed) return;
                    disposed = true;
                    shared.refCount -= 1;
                    if (shared.refCount > 0) return;
                    shared.controller.abort();
                    if (entry.acquiredReads.get(ownerId) === shared) entry.acquiredReads.delete(ownerId);
                },
            };
        },
        subscribe(input, listener, options) {
            const normalized = config.normalizeInput(input);
            const key = config.storeKey(normalized);
            const entry = ensureEntry(key, normalized, options);
            let subscribed = true;
            entry.listeners.add(listener);
            entry.refCount += 1;
            if (entry.refCount === 1) {
                entry.unsubscribeRecovery = config.subscribeRecovery?.(entry.input, revalidate => {
                    if (entry.refCount <= 0) return;
                    // Recovery may precede the old transport's final failed reply. Allow that
                    // reply to re-arm once without replacing a healthy outstanding watch.
                    if (entry.watching) {
                        entry.watchRecoveryRequested = true;
                        entry.watchRecoveryNeedsRefresh = true;
                    }
                    if (revalidate === true || (!entry.watching && (entry.watchRetired || config.shouldWatch?.(entry.state) === false))) {
                        // Authenticated reconnect revalidates even while an old watch is
                        // parked/preparing. Ordinary request-success wakes only repair failure.
                        entry.watchRetired = false;
                        if (entry.inFlight) entry.refreshRequested = true;
                        const refresh = runRefresh(entry);
                        if (config.watchAfterRefresh) void refresh.then(() => runWatchLoop(entry));
                        else runWatchLoop(entry);
                    }
                }) ?? null;
                // New demand refreshes the snapshot and renews a previously retired watch.
                entry.watchRetired = false;
                const previousWasAborted = entry.abortController?.signal.aborted;
                const refresh = runRefresh(entry);
                if (config.watchAfterRefresh || previousWasAborted) {
                    void refresh.then(async () => {
                        if (entry.refCount <= 0) return;
                        if (previousWasAborted) await runRefresh(entry);
                        if (config.watchAfterRefresh) runWatchLoop(entry);
                    });
                }
            }
            if (!config.watchAfterRefresh) runWatchLoop(entry);
            return () => {
                if (!subscribed) {
                    return;
                }
                subscribed = false;
                entry.listeners.delete(listener);
                if (entries.get(key) !== entry) return;
                entry.refCount -= 1;
                if (entry.refCount <= 0) {
                    entry.unsubscribeRecovery?.();
                    entry.unsubscribeRecovery = null;
                    entry.abortController?.abort();
                    setRefreshing(entry, false);
                    stopWatch(entry);
                    if (!config.retainState) {
                        entry.unsubscribeRetirement?.();
                        entry.unsubscribeRetirement = null;
                        entries.delete(key);
                    }
                }
            };
        },
        invalidate(input) {
            const normalized = config.normalizeInput(input);
            const entry = entries.get(config.storeKey(normalized));
            // An explicit invalidation also permits a new one-shot read of a retained entry.
            if (entry) entry.readStarted = false;
            if (entry && entry.refCount > 0) {
                if (entry.inFlight) entry.refreshRequested = true;
                const refresh = runRefresh(entry);
                // A user-initiated refresh is also the recovery path for a retired watch.
                if (entry.watching) entry.watchRecoveryRequested = true;
                entry.watchRetired = false;
                if (config.watchAfterRefresh) void refresh.then(() => runWatchLoop(entry));
                else runWatchLoop(entry);
            }
        },
        publish(input, snapshot, options) {
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
                if (snapshotCoversEntry && !snapshotCoversEntry(entry.input, snapshot, input)) {
                    if (entry.refCount <= 0) continue;
                    if (entry.inFlight) entry.refreshRequested = true;
                    void runRefresh(entry);
                    continue;
                }
                setState(entry, config.applySnapshot(entry.state, snapshot));
                if (options?.resumeWatch === false) continue;
                // An Action's successful read publishes here instead of calling
                // invalidate. Its fresh snapshot also restores the parked watch;
                // otherwise a recovered surface stops receiving later changes.
                if (entry.watching) entry.watchRecoveryRequested = true;
                entry.watchRetired = false;
                runWatchLoop(entry);
            }
        },
        reset() {
            for (const entry of entries.values()) {
                entry.refCount = 0;
                entry.unsubscribeRecovery?.();
                entry.unsubscribeRecovery = null;
                entry.unsubscribeRetirement?.();
                entry.unsubscribeRetirement = null;
                entry.abortController?.abort();
                for (const read of entry.acquiredReads.values()) read.controller.abort();
                entry.acquiredReads.clear();
                setRefreshing(entry, false);
                stopWatch(entry);
            }
            entries.clear();
        },
    };
}
