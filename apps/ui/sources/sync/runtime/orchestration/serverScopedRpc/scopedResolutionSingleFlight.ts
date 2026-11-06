import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';

/** The typed reader supplies complete authority, projection and invalidation identity. */
export type ScopedReadOptions = Readonly<{
    signal?: AbortSignal;
    /** Opaque captured authorities stay identity-partitioned; proven neutral bindings use their key. */
    scope?: ReadPartitionScope;
    /** A required fresh witness cannot join an earlier ordinary acquisition. */
    fresh?: boolean;
}>;

type ReadScope = object | string;
type ReadPartitionScope = ReadScope | readonly ReadScope[];

export type ScopedPhysicalReadOptions = ScopedReadOptions & Readonly<{
    /** Register physical custody or a selected batch item before dispatch/borrower retirement. */
    onPhysicalAcquire?: (signal: AbortSignal) => (() => void | Promise<void>) | void;
    /** Each live borrower observes issuance without owning the shared physical continuation. */
    onIssued?: () => void;
}>;

/** Ordered existing references partition pending work without assigning identities to them. */
function createReadPartitions<T>() {
    type Node = { children: Map<ReadScope, Node>; value?: T };
    const root: Node = { children: new Map() };
    const path = (scope: ReadPartitionScope): readonly ReadScope[] => Array.isArray(scope) ? scope : [scope];
    const find = (scope: ReadPartitionScope, create: boolean) => {
        let node = root;
        for (const key of path(scope)) {
            let child = node.children.get(key);
            if (!child) {
                if (!create) return undefined;
                child = { children: new Map() };
                node.children.set(key, child);
            }
            node = child;
        }
        return node;
    };
    const remove = (scope: ReadPartitionScope, expected?: T) => {
        let node = root;
        const ancestry: Array<{ parent: Node; key: ReadScope; child: Node }> = [];
        for (const key of path(scope)) {
            const child = node.children.get(key);
            if (!child) return;
            ancestry.push({ parent: node, key, child });
            node = child;
        }
        if (expected !== undefined && node.value !== expected) return;
        delete node.value;
        if (expected === undefined) node.children.clear();
        for (let index = ancestry.length - 1; index >= 0; index -= 1) {
            const { parent, key, child } = ancestry[index]!;
            if (child.value !== undefined || child.children.size > 0 || parent.children.get(key) !== child) break;
            parent.children.delete(key);
        }
    };
    return {
        get: (scope: ReadPartitionScope) => find(scope, false)?.value,
        set: (scope: ReadPartitionScope, value: T) => { find(scope, true)!.value = value; },
        forget: (scope: ReadPartitionScope, value: T) => remove(scope, value),
        invalidate: (scope: ReadPartitionScope) => remove(scope),
        clear: () => { root.children.clear(); delete root.value; },
    };
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? Object.assign(new Error('Scoped read cancelled'), { name: 'AbortError' });
}

/** Pending work only: parsing, admission, retry cadence and retained data belong to domain owners. */
export type ScopedResolutionSingleFlight<T> = Readonly<{
    run: (key: string, resolve: (signal: AbortSignal, onIssued: () => void) => Promise<T>, options?: ScopedPhysicalReadOptions & Readonly<{
        onResolved?: (value: T, live: boolean) => void;
        onPhysicalResolved?: (value: T, borrowers: number) => void;
    }>) => Promise<T>;
    /** Forget joins after a write/wake without cancelling incumbent operations or their publication fences. */
    invalidate: (scope?: ReadPartitionScope, affected?: (key: string) => boolean) => void;
    reset: () => void;
}>;

/** An explicit owner signal retains physical work independently of borrower demand. */
export function createScopedResolutionSingleFlight<T>(ownerSignal?: AbortSignal): ScopedResolutionSingleFlight<T> {
    type Flight = { result: Promise<T>; abort: AbortController; waiters: number; settled: boolean;
        issued: boolean; issuanceListeners?: Set<() => void>; resolutionListeners?: Set<() => void> };
    const defaultScope = {};
    const partitions = createReadPartitions<Map<string, Flight>>();

    return {
        async run(key, resolve, options = {}) {
            throwIfAborted(options.signal);
            const scope = options.fresh ? {} : options.scope ?? defaultScope;
            let reads = partitions.get(scope);
            if (!reads) {
                reads = new Map();
                partitions.set(scope, reads);
            }
            const partition = reads;
            let flight = partition.get(key);
            const forget = (entry: Flight) => {
                if (partition.get(key) !== entry) return;
                partition.delete(key);
                if (partition.size === 0) partitions.forget(scope, partition);
            };
            if (!flight) {
                const abort = new AbortController();
                const physicalSignal = ownerSignal ?? abort.signal;
                let dispose: (() => void | Promise<void>) | void;
                try {
                    dispose = options.onPhysicalAcquire?.(physicalSignal);
                } catch (error) {
                    if (partition.size === 0) partitions.forget(scope, partition);
                    throw error;
                }
                const operation = Promise.resolve().then(() => {
                    throwIfAborted(physicalSignal);
                    return resolve(physicalSignal, () => {
                        created.issued = true;
                        for (const listener of [...(created.issuanceListeners ?? [])]) listener();
                        throwIfAborted(physicalSignal);
                    });
                });
                // Also disposes a selected capture when its final borrower
                // leaves before the deferred resolver gets a chance to run.
                const result = dispose ? operation.finally(dispose) : operation;
                flight = { result, abort, waiters: 0, settled: false, issued: false };
                const created = flight;
                partition.set(key, created);
                const finish = () => { created.settled = true; forget(created); };
                void result.then(value => {
                    if (created.resolutionListeners) for (const listener of created.resolutionListeners) listener();
                    options.onPhysicalResolved?.(value, created.waiters);
                    finish();
                }, finish);
            }
            const read = flight;
            read.waiters += 1;
            return await new Promise<T>((accept, reject) => {
                let left = false;
                let resolutionExpected = false;
                const expectResolution = options.onResolved ? () => { resolutionExpected = true; } : undefined;
                if (expectResolution) (read.resolutionListeners ??= new Set()).add(expectResolution);
                const leave = () => {
                    if (left) return;
                    left = true;
                    read.issuanceListeners?.delete(onIssued);
                    if (expectResolution) read.resolutionListeners?.delete(expectResolution);
                    options.signal?.removeEventListener('abort', onAbort);
                    read.waiters -= 1;
                    if (!ownerSignal && read.waiters === 0 && !read.settled) {
                        forget(read);
                        read.abort.abort(options.signal?.reason);
                    }
                };
                const onAbort = () => {
                    if (left || !options.signal) return;
                    const reason = abortReason(options.signal);
                    leave();
                    reject(reason);
                };
                const onIssued = () => {
                    if (left) return;
                    try { options.onIssued?.(); }
                    catch (error) { leave(); reject(error); }
                };
                if (options.onIssued) (read.issuanceListeners ??= new Set()).add(onIssued);
                options.signal?.addEventListener('abort', onAbort, { once: true });
                if (options.signal?.aborted) onAbort();
                else if (read.issued) onIssued();
                void read.result.then(value => {
                    if (left) {
                        if (resolutionExpected) options.onResolved?.(value, false);
                        return;
                    }
                    leave();
                    try { options.onResolved?.(value, true); accept(value); }
                    catch (error) { reject(error); }
                }, error => {
                    if (left) return;
                    leave();
                    reject(error);
                });
            });
        },
        invalidate(scope = defaultScope, affected) {
            if (affected) {
                const reads = partitions.get(scope);
                if (reads) for (const key of reads.keys()) if (affected(key)) reads.delete(key);
                if (reads?.size === 0) partitions.forget(scope, reads);
            } else partitions.invalidate(scope);
        },
        reset() {
            partitions.clear();
        },
    };
}

type BatchRead<T> = (ids: readonly string[], signal: AbortSignal,
    publish: (values: ReadonlyMap<string, T>) => void) => Promise<ReadonlyMap<string, T>>;

/** Finite work belonging to one delivered physical chunk, partitioned by its real destination. */
export type ScopedBatchResolutionContext = Readonly<{
    /** Register in onResolved; preparation must settle before awaiting this publication. */
    publish<R>(destination: object, preparation: Promise<R | null>, apply: (entries: readonly R[]) => void | Promise<void>): Promise<void>;
}>;

function createBatchResolutionContext(ids: readonly string[]) {
    let remainingIds = ids.length;
    let remainingDeliveries = 0;
    let close!: () => void;
    const delivered = new Promise<void>(resolve => { close = resolve; });
    const groups = new Map<object, { add: (preparation: Promise<unknown>) => Promise<void> }>();
    const check = () => { if (remainingIds === 0 && remainingDeliveries === 0) close(); };
    return {
        expect(borrowers: number) { remainingIds -= 1; remainingDeliveries += borrowers; check(); },
        delivered() { remainingDeliveries -= 1; check(); },
        context: {
            publish<R>(destination: object, preparation: Promise<R | null>, apply: (entries: readonly R[]) => void | Promise<void>): Promise<void> {
                let group = groups.get(destination);
                if (!group) {
                    const work: Promise<R | null>[] = [];
                    const publication = delivered.then(async () => {
                        const results = await Promise.allSettled(work);
                        await apply(results.flatMap(result => result.status === 'fulfilled' && result.value !== null ? [result.value] : []));
                    });
                    group = { add: pending => {
                        // Each destination identifies one typed publication in this finite group.
                        work.push(pending as Promise<R | null>);
                        return publication;
                    } };
                    groups.set(destination, group);
                }
                return group.add(preparation);
            },
        } satisfies ScopedBatchResolutionContext,
    };
}

export type ScopedBatchReadPreparation<T> = Readonly<{
    /** Settle this reservation once the caller has prepared its selected ids. */
    run: (ids: readonly string[], read: BatchRead<T>, signal?: AbortSignal,
        onResolved?: (id: string, value: T, context?: ScopedBatchResolutionContext) => void) => Promise<ReadonlyMap<string, T>>;
    /** A failed or abandoned preparation must not hold other ready readers. */
    release: () => void;
}>;

export type ScopedBatchResolutionSingleFlight<T> = Readonly<{
    /** Register before awaiting preparation, under the already captured authority/projection key. */
    reserve: (groupKey: string, options?: ScopedReadOptions) => ScopedBatchReadPreparation<T>;
    run: (groupKey: string, ids: readonly string[],
        read: BatchRead<T>,
        options?: ScopedReadOptions) => Promise<ReadonlyMap<string, T>>;
    invalidate: (scope?: ReadPartitionScope, affected?: (id: string) => boolean) => void;
    reset: () => void;
}>;

/** Gathers ids at the same pending owner; each typed adapter keeps its existing wire/body budget. */
export function createScopedBatchResolutionSingleFlight<T>(configuration: Readonly<{ materializePhysicalChunks?: true; ownerSignal?: AbortSignal }> = {}): ScopedBatchResolutionSingleFlight<T> {
    // Session opening needs finite borrower completion. Other resource readers
    // retain ordinary raw delivery without allocating materialization contexts.
    const materializePhysicalChunks = configuration.materializePhysicalChunks === true;
    const defaultScope = {};
    type Resolved = { value: T; batch: ReturnType<typeof createBatchResolutionContext> };
    type ItemResult = T | Resolved;
    type Item = { id: string; signal: AbortSignal; read: BatchRead<T>; accept: (value: ItemResult) => void; reject: (error: unknown) => void };
    type Batch = { items: Item[]; preparations: number; scheduled: boolean };
    type Partition = { reads: ScopedResolutionSingleFlight<ItemResult>; groups: Map<string, Batch>; users: number; physical: number };
    const partitions = createReadPartitions<Partition>();

    function acquire(options: ScopedReadOptions) {
        throwIfAborted(options.signal);
        const scope = options.fresh ? {} : options.scope ?? defaultScope;
        let partition = partitions.get(scope);
        if (!partition) {
            partition = { reads: createScopedResolutionSingleFlight<ItemResult>(configuration.ownerSignal), groups: new Map(), users: 0, physical: 0 };
            partitions.set(scope, partition);
        }
        const captured = partition;
        captured.users += 1;
        return { partition: captured, release: () => {
            captured.users -= 1;
            if (captured.users === 0 && captured.physical === 0 && captured.groups.size === 0) partitions.forget(scope, captured);
        }, forgetIfIdle: () => {
            if (captured.users === 0 && captured.physical === 0 && captured.groups.size === 0) partitions.forget(scope, captured);
        } };
    }

    function batchFor(partition: Partition, groupKey: string): Batch {
        let batch = partition.groups.get(groupKey);
        if (!batch) {
            batch = { items: [], preparations: 0, scheduled: false };
            partition.groups.set(groupKey, batch);
        }
        return batch;
    }

    function flushWhenPrepared(acquisition: ReturnType<typeof acquire>, groupKey: string, batch: Batch) {
        if (batch.scheduled || batch.preparations > 0) return;
        batch.scheduled = true;
        // Only registered preparations define the frontier; Promise depth and
        // timer service never determine how long an ordinary batch gathers.
        queueMicrotask(() => {
            batch.scheduled = false;
            if (batch.preparations > 0) return;
            if (acquisition.partition.groups.get(groupKey) === batch) acquisition.partition.groups.delete(groupKey);
            acquisition.forgetIfIdle();
            void dispatch(batch);
        });
    }

    async function dispatch(batch: Batch) {
        const items = batch.items.filter(item => !item.signal.aborted);
        for (const item of batch.items) if (item.signal.aborted) item.reject(abortReason(item.signal));
        const first = items[0];
        if (!first) return;
        const abort = new AbortController();
        // The per-id single flight selects one live physical item per id. Keep only
        // unsettled items here, so an abort or published chunk touches its own items.
        const pending = new Map<string, { item: Item; onAbort: () => void }>();
        let wanted = items.length;
        const cancelIfUnwanted = () => {
            if (pending.size > 0 && wanted === 0) abort.abort();
        };
        for (const item of items) {
            const onAbort = () => {
                if (!pending.has(item.id)) return;
                wanted -= 1;
                cancelIfUnwanted();
            };
            pending.set(item.id, { item, onAbort });
            item.signal.addEventListener('abort', onAbort, { once: true });
        }
        try {
            cancelIfUnwanted();
            throwIfAborted(abort.signal);
            // Typed adapters validate a complete physical chunk before publishing
            // it. Settle its selected items now, retaining later items in this
            // same pending owner rather than holding every borrower at a barrier.
            const publish = (values: ReadonlyMap<string, T>) => {
                const resolvedBatch = materializePhysicalChunks ? createBatchResolutionContext(
                    [...values.keys()].filter(id => pending.has(id) && !pending.get(id)!.item.signal.aborted),
                ) : undefined;
                for (const [id, value] of values) {
                    const entry = pending.get(id);
                    if (!entry) continue;
                    const { item, onAbort } = entry;
                    pending.delete(id);
                    item.signal.removeEventListener('abort', onAbort);
                    if (item.signal.aborted) item.reject(abortReason(item.signal));
                    else {
                        wanted -= 1;
                        item.accept(resolvedBatch ? { value, batch: resolvedBatch } : value);
                    }
                }
                cancelIfUnwanted();
            };
            const result = await first.read(items.map(item => item.id), abort.signal, publish);
            if (pending.size > 0) {
                const completed = new Map<string, T>();
                // Map.has establishes presence even when T itself permits undefined.
                for (const id of pending.keys()) if (result.has(id)) completed.set(id, result.get(id) as T);
                publish(completed);
            }
            for (const { item } of pending.values()) {
                if (item.signal.aborted) item.reject(abortReason(item.signal));
                else item.reject(new Error('Scoped batch omitted a requested resource'));
            }
        } catch (error) {
            for (const { item } of pending.values()) item.reject(error);
        } finally {
            for (const { item, onAbort } of pending.values()) item.signal.removeEventListener('abort', onAbort);
            pending.clear();
        }
    }

    async function run(acquisition: ReturnType<typeof acquire>, groupKey: string, batch: Batch,
        ids: readonly string[], read: BatchRead<T>, options: ScopedReadOptions, signal?: AbortSignal,
        onResolved?: (id: string, value: T, context?: ScopedBatchResolutionContext) => void) {
        const invocation = new AbortController();
        const cancellation = mergeAbortSignals([invocation.signal, options.signal, signal]);
        try {
            throwIfAborted(cancellation.signal);
            const pending = Promise.all([...new Set(ids)].map(async id => {
                let selected!: Promise<ItemResult>;
                const value = await acquisition.partition.reads.run(JSON.stringify([groupKey, id]), () => selected, {
                    signal: cancellation.signal,
                    ...(materializePhysicalChunks ? {
                        onPhysicalResolved: (result: ItemResult, borrowers: number) => (result as Resolved).batch.expect(borrowers),
                        onResolved: (result: ItemResult, live: boolean) => {
                            const resolved = result as Resolved;
                            try { if (live) { throwIfAborted(cancellation.signal); onResolved?.(id, resolved.value, resolved.batch.context); } }
                            finally { resolved.batch.delivered(); }
                        },
                    } : {}),
                    onPhysicalAcquire: signal => {
                        // Selection is synchronous: a ready flush may already
                        // be queued when another preparation settles its ids.
                        selected = new Promise<ItemResult>((accept, reject) => {
                            batch.items.push({ id, signal, read, accept, reject });
                        });
                        // The last borrower can leave before the deferred
                        // resolver runs; dispatch still settles its queued item.
                        void selected.catch(() => {});
                        flushWhenPrepared(acquisition, groupKey, batch);
                        // An explicit resource owner keeps the pending partition
                        // joinable even when its last visible borrower leaves.
                        if (configuration.ownerSignal) {
                            acquisition.partition.physical++;
                            return () => { acquisition.partition.physical--; acquisition.forgetIfIdle(); };
                        }
                    },
                });
                throwIfAborted(cancellation.signal);
                if (!materializePhysicalChunks) onResolved?.(id, value as T);
                return [id, materializePhysicalChunks ? (value as Resolved).value : value as T] as const;
            }));
            flushWhenPrepared(acquisition, groupKey, batch);
            const values = await pending;
            throwIfAborted(cancellation.signal);
            return new Map(values);
        } finally {
            // Promise.all can fail while sibling items remain pending. This
            // invocation no longer wants them; independent borrowers stay.
            invocation.abort();
            cancellation.dispose();
            acquisition.release();
        }
    }

    return {
        reserve(groupKey, options = {}) {
            const acquisition = acquire(options);
            const batch = batchFor(acquisition.partition, groupKey);
            batch.preparations += 1;
            let open = true;
            const release = () => {
                if (!open) return;
                open = false;
                options.signal?.removeEventListener('abort', release);
                batch.preparations -= 1;
                flushWhenPrepared(acquisition, groupKey, batch);
                acquisition.release();
            };
            options.signal?.addEventListener('abort', release, { once: true });
            return {
                run(ids, read, signal, onResolved) {
                    if (!open) {
                        return Promise.reject(options.signal?.aborted ? abortReason(options.signal)
                            : new Error('Scoped read preparation has already ended'));
                    }
                    // Retain this exact partition even if invalidation has
                    // withdrawn its joins while preparation was awaiting.
                    acquisition.partition.users += 1;
                    try { return run(acquisition, groupKey, batch, ids, read, options, signal, onResolved); }
                    finally { release(); }
                },
                release,
            };
        },
        async run(groupKey, ids, read, options = {}) {
            const acquisition = acquire(options);
            return await run(acquisition, groupKey, batchFor(acquisition.partition, groupKey), ids, read, options);
        },
        invalidate(scope = defaultScope, affected) {
            // Incumbents keep their own pending owner; preparations may not
            // join or delay the successor partition after invalidation.
            if (affected) partitions.get(scope)?.reads.invalidate(undefined, key => affected((JSON.parse(key) as [string, string])[1]));
            else partitions.invalidate(scope);
        },
        reset() {
            partitions.clear();
        },
    };
}
