import type { RequesterWorkAttributionV1 } from './requesterWorkAttribution';
import type { ActivityDecisionV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { isCanonicalAbsolutePathInsideRoot, resolveCanonicalAbsolutePathComparisonIdentity } from '@/utils/path/expandHomeDirPath';

/** Private composition of incumbent work owners; never a persisted liveness store. */
export type LiveWorkCategoryV1 = 'session' | 'finite' | 'terminal' | 'service'
    | 'transfer' | 'handoff' | 'sync' | 'setup' | 'input' | 'execution_run' | 'workflow_run' | 'agents' | 'attention';

export type LiveWorkItemV1 = Readonly<{
    category: LiveWorkCategoryV1;
    // References remain opaque to the privacy projection. The inventory producer
    // supplies the actual canonical process/operation and terminal references.
    ownerRef: unknown;
    attribution: RequesterWorkAttributionV1 | Readonly<{ kind: 'unknown' }>;
    lifecyclePurpose?: 'development' | 'deployment' | 'infrastructure';
    state: 'active' | 'settled' | 'unknown';
    /** Owner-reported anchor; never reconstructed from daemon uptime. */
    settledAt?: number;
    activeCount?: number;
    associatedTerminal?: unknown;
    /** Canonical Session workspace facts; private, not another work-state owner. */
    workspacePath?: string;
    workspaceId?: string;
}>;

export type LiveWorkInventoryV1 = Readonly<{
    items: readonly LiveWorkItemV1[];
    coverage: 'complete' | 'unknown';
    idleSince?: number;
}>;

/** Observations retire pending reads without claiming a material work edge. */
export type LiveWorkListenerV1 = (change?: 'observation') => void;

export type LiveWorkProducerV1 = Readonly<{
    read(): Omit<LiveWorkInventoryV1, 'idleSince'> | Promise<Omit<LiveWorkInventoryV1, 'idleSince'>>;
    subscribe(listener: LiveWorkListenerV1): () => void;
}>;

export type ManagedActivityInventory = Readonly<{
    read(): Promise<LiveWorkInventoryV1>;
    readDecision(): Promise<ActivityDecisionV1>;
    subscribe(listener: (decision: ActivityDecisionV1) => void): () => void;
    /** Per-item facts, excluding the aggregate Machine retention anchor. */
    subscribeFacts(listener: () => void): () => void;
    dispose(): void;
}>;

/** Project-service eligibility reads Session facts, never the service's residency. */
export function readWorkspaceSessionIdle(
    inventory: LiveWorkInventoryV1,
    workspace: Readonly<{ workspacePath: string; workspaceId?: string }>,
): boolean | null {
    if (inventory.coverage !== 'complete'
        || resolveCanonicalAbsolutePathComparisonIdentity(workspace.workspacePath) === null) return null;
    const sessionItems = inventory.items.filter(item => item.category === 'session' || item.category === 'input'
        || item.category === 'agents' || item.category === 'attention');
    let unknown = false;
    for (const item of sessionItems) {
        const sameWorkspace = workspace.workspaceId && item.workspaceId
            ? workspace.workspaceId === item.workspaceId
            : item.workspacePath && resolveCanonicalAbsolutePathComparisonIdentity(item.workspacePath) !== null
                ? isCanonicalAbsolutePathInsideRoot(workspace.workspacePath, item.workspacePath) : null;
        if (sameWorkspace === false || item.state === 'settled') continue;
        if (sameWorkspace === null || item.state === 'unknown') unknown = true;
        else if (item.state === 'active') return false;
    }
    return unknown ? null : true;
}

/** Binds late/replaced incumbent owners; retains references, never copied work state. */
export function createLiveWorkProducerGroup(resolve: () => readonly LiveWorkProducerV1[] | null) {
    const listeners = new Set<LiveWorkListenerV1>();
    const subscriptions = new Map<LiveWorkProducerV1, () => void>();
    let observing = false;
    let disposed = false;
    const notifyChanged: LiveWorkListenerV1 = change => { if (!disposed) for (const listener of listeners) listener(change); };
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
        subscribe(listener: LiveWorkListenerV1) {
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
 * Passive publications refresh only their emitting owner. Peer projections stay
 * in this inventory lifetime; explicit confirmations still read every live owner.
 */
export function createManagedActivityInventory(params: Readonly<{
    producers: readonly LiveWorkProducerV1[];
    now?: () => number;
}>): ManagedActivityInventory {
    const now = params.now ?? Date.now;
    const listeners = new Set<(decision: ActivityDecisionV1) => void>();
    const factListeners = new Set<() => void>();
    let publishedFacts: Omit<LiveWorkInventoryV1, 'idleSince'> | undefined;
    let idleSince: number | undefined;
    let priorDecision: ActivityDecisionV1 | undefined;
    let publishedOwnerEdge = -1;
    let disposed = false;
    let ownerEdge = 0;
    const producerObservations = new Map<LiveWorkProducerV1, Promise<Omit<LiveWorkInventoryV1, 'idleSince'>>>();
    let inFlight: Readonly<{ ownerEdge: number; allOwners: boolean; result: Promise<LiveWorkInventoryV1> }> | null = null;
    let unsubscribe: Array<() => void> | null = null;
    const observe = () => {
        if (unsubscribe || disposed) return;
        unsubscribe = [];
        for (const producer of params.producers) {
            unsubscribe.push(producer.subscribe(change => {
                // A material invalidation may coalesce active→settled before
                // the exact owner can be reread. Never carry idle through that gap.
                if (change !== 'observation') idleSince = undefined;
                ownerEdge += 1;
                void read(producer);
            }));
        }
    };
    const read = (changedProducer?: LiveWorkProducerV1): Promise<LiveWorkInventoryV1> => {
        observe();
        const observedEdge = ownerEdge;
        // A passive partial projection cannot satisfy a fresh all-owner confirmation.
        // Concurrent full confirmations still share their pending live observation.
        if (inFlight?.ownerEdge === observedEdge && (changedProducer !== undefined || inFlight.allOwners)) return inFlight.result;
        // Capture synchronous owner edges immediately. Deferring the read until
        // a prior asynchronous producer settles would lose busy→idle within one turn.
        let allOwners = true;
        const observationsPending = Promise.allSettled(params.producers.map(producer => {
            const previous = producerObservations.get(producer);
            if (changedProducer !== undefined && producer !== changedProducer && previous) {
                allOwners = false;
                return previous;
            }
            let observation: Promise<Omit<LiveWorkInventoryV1, 'idleSince'>>;
            try {
                observation = Promise.resolve(producer.read()).catch(() => ({ items: [], coverage: 'unknown' as const }));
            } catch {
                observation = Promise.resolve({ items: [], coverage: 'unknown' as const });
            }
            // Retain only the owner's projection, not a rejected transport's
            // credential-bearing error. A failed owner never proves absence.
            producerObservations.set(producer, observation);
            return observation;
        }));
        const next = observationsPending.then(observations => {
            const items: LiveWorkItemV1[] = [];
            let coverage: LiveWorkInventoryV1['coverage'] = observations.length ? 'complete' : 'unknown';
            for (const observation of observations) {
                if (observation.status === 'rejected') { coverage = 'unknown'; continue; }
                items.push(...observation.value.items);
                if (observation.value.coverage === 'unknown') coverage = 'unknown';
            }
            // A retired observation neither blocks its successor nor changes the
            // successor's idle anchor/publication when its transport finally replies.
            if (observedEdge !== ownerEdge || inFlight?.result !== next) return { items, coverage: 'unknown' as const };
            const settled = coverage === 'complete' && items.every(item => item.state === 'settled');
            // All applicable asynchronous owners must have proved absence before
            // starting the interval; a slow read cannot backdate an idle proof.
            idleSince = settled ? idleSince ?? now() : undefined;
            const inventory: LiveWorkInventoryV1 = { items, coverage, ...(idleSince === undefined ? {} : { idleSince }) };
            const decision = projectManagedActivityDecision(inventory);
            const factsChanged = factListeners.size > 0 && (!publishedFacts || publishedFacts.coverage !== coverage
                || publishedFacts.items.length !== items.length
                || items.some((item, index) => {
                    const previous = publishedFacts!.items[index];
                    return previous.ownerRef !== item.ownerRef || previous.category !== item.category
                        || previous.state !== item.state || previous.settledAt !== item.settledAt
                        || previous.activeCount !== item.activeCount || previous.associatedTerminal !== item.associatedTerminal
                        || previous.workspacePath !== item.workspacePath || previous.workspaceId !== item.workspaceId
                        || JSON.stringify(previous.attribution) !== JSON.stringify(item.attribution);
                }));
            if (factsChanged) {
                publishedFacts = { items, coverage };
                if (!disposed) for (const listener of factListeners) {
                    try { listener(); } catch { /* Observation cannot change work custody. */ }
                }
            }
            if (observedEdge !== publishedOwnerEdge || JSON.stringify(decision) !== JSON.stringify(priorDecision)) {
                publishedOwnerEdge = observedEdge;
                priorDecision = decision;
                if (!disposed) for (const listener of listeners) {
                    try { listener(decision); } catch { /* Observation cannot change work custody. */ }
                }
            }
            return inventory;
        });
        inFlight = { ownerEdge: observedEdge, allOwners, result: next };
        const release = () => { if (inFlight?.result === next) inFlight = null; };
        void next.then(release, release);
        return next;
    };
    return {
        read,
        readDecision: async () => projectManagedActivityDecision(await read()),
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        subscribeFacts(listener) {
            factListeners.add(listener);
            return () => { factListeners.delete(listener); if (!factListeners.size) publishedFacts = undefined; };
        },
        dispose() { disposed = true; for (const cleanup of unsubscribe ?? []) cleanup(); listeners.clear(); factListeners.clear(); publishedFacts = undefined; producerObservations.clear(); inFlight = null; },
    };
}
