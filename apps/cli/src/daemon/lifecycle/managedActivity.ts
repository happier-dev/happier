import type { RequesterWorkAttributionV1 } from './requesterWorkAttribution';
import type { ActivityDecisionV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';

/** Private composition of incumbent work owners; never a persisted liveness store. */
export type LiveWorkCategoryV1 = 'session' | 'finite' | 'terminal' | 'service'
    | 'transfer' | 'handoff' | 'sync' | 'setup' | 'input' | 'execution_run' | 'workflow_run';

export type LiveWorkItemV1 = Readonly<{
    category: LiveWorkCategoryV1;
    // References remain opaque to the privacy projection. The inventory producer
    // supplies the actual canonical process/operation and terminal references.
    ownerRef: unknown;
    attribution: RequesterWorkAttributionV1 | Readonly<{ kind: 'unknown' }>;
    state: 'active' | 'settled' | 'unknown';
    associatedTerminal?: unknown;
}>;

export type LiveWorkInventoryV1 = Readonly<{
    items: readonly LiveWorkItemV1[];
    coverage: 'complete' | 'unknown';
    idleSince?: number;
}>;

export type LiveWorkProducerV1 = Readonly<{
    read(): Omit<LiveWorkInventoryV1, 'idleSince'> | Promise<Omit<LiveWorkInventoryV1, 'idleSince'>>;
    subscribe(listener: () => void): () => void;
}>;

export type ManagedActivityInventory = Readonly<{
    read(): Promise<LiveWorkInventoryV1>;
    readDecision(): Promise<ActivityDecisionV1>;
    subscribe(listener: (decision: ActivityDecisionV1) => void): () => void;
    dispose(): void;
}>;

/** Binds late/replaced incumbent owners; retains references, never copied work state. */
export function createLiveWorkProducerGroup(resolve: () => readonly LiveWorkProducerV1[] | null) {
    const listeners = new Set<() => void>();
    const subscriptions = new Map<LiveWorkProducerV1, () => void>();
    let observing = false;
    let disposed = false;
    const notifyChanged = () => { if (!disposed) for (const listener of listeners) listener(); };
    const read = () => {
        const owners = resolve();
        if (observing) {
            const current = new Set(owners ?? []);
            for (const [owner, cleanup] of subscriptions) if (!current.has(owner)) {
                cleanup(); subscriptions.delete(owner);
            }
            for (const owner of current) if (!subscriptions.has(owner)) {
                subscriptions.set(owner, owner.subscribe(notifyChanged));
            }
        }
        if (!owners?.length || disposed) return { items: [], coverage: 'unknown' as const };
        const snapshots = owners.map(owner => {
            try { return owner.read(); } catch (error) { return Promise.reject(error); }
        });
        return Promise.allSettled(snapshots).then(results => {
            const items: LiveWorkItemV1[] = [];
            let coverage: LiveWorkInventoryV1['coverage'] = 'complete';
            for (const result of results) {
                if (result.status === 'rejected') { coverage = 'unknown'; continue; }
                items.push(...result.value.items);
                if (result.value.coverage === 'unknown') coverage = 'unknown';
            }
            return { items, coverage };
        });
    };
    return {
        read,
        subscribe(listener: () => void) {
            observing = true; listeners.add(listener);
            return () => {
                listeners.delete(listener);
                if (!listeners.size) {
                    observing = false;
                    for (const cleanup of subscriptions.values()) cleanup();
                    subscriptions.clear();
                }
            };
        },
        notifyChanged,
        dispose() {
            disposed = true;
            for (const cleanup of subscriptions.values()) cleanup();
            subscriptions.clear(); listeners.clear();
        },
    } satisfies LiveWorkProducerV1 & { notifyChanged(): void; dispose(): void };
}

/** References and requester attribution stay in the daemon; only reasons cross the bridge. */
export function projectManagedActivityDecision(inventory: LiveWorkInventoryV1): ActivityDecisionV1 {
    const linkedTerminals = new Set(inventory.items.filter(item => item.category !== 'terminal'
        && item.state !== 'settled' && item.associatedTerminal !== undefined).map(item => item.associatedTerminal));
    const materialItems = inventory.items.filter(item => item.state !== 'settled'
        && !(item.category === 'terminal' && linkedTerminals.has(item.ownerRef)));
    const active = [...new Set(materialItems.filter(item => item.state === 'active').map(item => item.category))];
    if (active.length) return { kind: 'busy', reasons: active };
    const unknown: Array<LiveWorkCategoryV1 | 'coverage_unknown'> = [...new Set(materialItems.filter(item => item.state === 'unknown').map(item => item.category))];
    if (inventory.coverage === 'unknown') unknown.push('coverage_unknown');
    if (unknown.length || inventory.idleSince === undefined) {
        return { kind: 'unknown', reasons: unknown.length ? unknown : ['coverage_unknown'] };
    }
    return { kind: 'idle', since: inventory.idleSince };
}

/**
 * The only retained fact is the aggregate settled edge's timestamp. Each read
 * still queries the original producers; a failed read cannot manufacture zero.
 */
export function createManagedActivityInventory(params: Readonly<{
    producers: readonly LiveWorkProducerV1[];
    now?: () => number;
}>): ManagedActivityInventory {
    const now = params.now ?? Date.now;
    const listeners = new Set<(decision: ActivityDecisionV1) => void>();
    let idleSince: number | undefined;
    let priorDecision: ActivityDecisionV1 | undefined;
    let disposed = false;
    let reads = Promise.resolve();
    let ownerEdge = 0;
    let unsubscribe: Array<() => void> | null = null;
    const observe = () => {
        if (unsubscribe || disposed) return;
        unsubscribe = [];
        for (const producer of params.producers) {
            unsubscribe.push(producer.subscribe(() => {
                // An asynchronous invalidation may coalesce active→settled before
                // the exact owner can be reread. Never carry idle through that gap.
                idleSince = undefined;
                ownerEdge += 1;
                void read();
            }));
        }
    };
    const read = (): Promise<LiveWorkInventoryV1> => {
        observe();
        const observedEdge = ownerEdge;
        // Capture synchronous owner edges immediately. Deferring the read until
        // a prior asynchronous producer settles would lose busy→idle within one turn.
        const observationsPending = Promise.allSettled(params.producers.map(producer => {
            try { return producer.read(); } catch (error) { return Promise.reject(error); }
        }));
        const next = reads.then(async () => {
            const observations = await observationsPending;
            const items: LiveWorkItemV1[] = [];
            let coverage: LiveWorkInventoryV1['coverage'] = observations.length ? 'complete' : 'unknown';
            for (const observation of observations) {
                if (observation.status === 'rejected') { coverage = 'unknown'; continue; }
                items.push(...observation.value.items);
                if (observation.value.coverage === 'unknown') coverage = 'unknown';
            }
            if (observedEdge !== ownerEdge) coverage = 'unknown';
            const settled = coverage === 'complete' && items.every(item => item.state === 'settled');
            // All applicable asynchronous owners must have proved absence before
            // starting the interval; a slow read cannot backdate an idle proof.
            idleSince = settled ? idleSince ?? now() : undefined;
            const inventory: LiveWorkInventoryV1 = { items, coverage, ...(idleSince === undefined ? {} : { idleSince }) };
            const decision = projectManagedActivityDecision(inventory);
            if (JSON.stringify(decision) !== JSON.stringify(priorDecision)) {
                priorDecision = decision;
                if (!disposed) for (const listener of listeners) {
                    try { listener(decision); } catch { /* Observation cannot change work custody. */ }
                }
            }
            return inventory;
        });
        reads = next.then(() => {}, () => {});
        return next;
    };
    return {
        read,
        readDecision: async () => projectManagedActivityDecision(await read()),
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        dispose() { disposed = true; for (const cleanup of unsubscribe ?? []) cleanup(); listeners.clear(); },
    };
}
