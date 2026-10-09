import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    subscribeHomeAccountChange,
    subscribeHomeCredentialChange,
    type HomeAccountChangeEvent,
    type HomeCredentialMutationEvent,
} from '@/sync/runtime/orchestration/homeAccountChange';

/**
 * The loading lifecycle shared by every server-Account-scoped, reconstructible
 * snapshot domain.
 *
 * Home governance and Teams are woken by the same content-free Account-change
 * signal, so *when to refetch* is one decision and lives here. A domain supplies
 * only what it owns: how to read its target and how to mark its own rows stale.
 *
 * The lifecycle is deliberately small — observation counting, single flight, one
 * coalesced trailing reload, captured-Account cleanup, and one refcounted lifecycle subscription pair. There is no cursor,
 * replay, generation, ordering machinery, second socket or polling timer.
 */

export type ScopedLoadTarget = Readonly<{
    /** Collision-safe identity of the exact thing being loaded. */
    key: string;
    /** The Home this target belongs to, used to match the wake. */
    serverId: string;
}>;

export type ScopedSnapshotLoader<TTarget extends ScopedLoadTarget> = Readonly<{
    /** Registers a live consumer and loads when the domain says it is needed. */
    observe: (target: TTarget) => () => void;
    /** Explicit retry. Coalesces with an in-flight load for the same target. */
    refresh: (target: TTarget) => Promise<void>;
    /** Invalidates now and awaits the newest load, including a required trailing reload. */
    invalidate: (target: TTarget) => Promise<void>;
    resetForTests: () => void;
}>; 

export type ScopedSnapshotLoadContext = Readonly<{
    /**
     * Whether this request can publish authority-bearing data as current.
     * A wake or observer gap that happened after the request began makes
     * its answer useful for continuity only; the queued read is authoritative.
     */
    isCurrent: () => boolean;
    /** Publishes a checked read before its retained cleanup, without late obsolete publication. */
    readWithMaintenance: <TProjection>(input: Readonly<{
        read: (publication: ScopedSnapshotReadPublication<TProjection>) => Promise<TProjection>;
        publish: (projection: TProjection, current: boolean) => void;
        getPublication: () => unknown;
    }>) => Promise<void | ScopedSnapshotLoadMaintenance>;
}>;

export type ScopedSnapshotReadPublication<TProjection> = Readonly<{
    onReady: (projection: TProjection, isAccountCurrent: () => boolean) => void;
    hasPendingCleanup: () => boolean;
}>;

export type ScopedSnapshotLoadMaintenance = Readonly<{
    /** The reader retains and disposes its captured Account until cleanup settles. */
    maintenance: Promise<void>;
    isMaintenanceCurrent: () => boolean;
}>;

export function createScopedSnapshotLoader<TTarget extends ScopedLoadTarget>(params: Readonly<{
    /** Reads the target and publishes the outcome into the domain's store. */
    load: (target: TTarget, context: ScopedSnapshotLoadContext) => Promise<void | ScopedSnapshotLoadMaintenance>;
    /**
     * Whether a newly observed target needs a read. The domain decides this from
     * its own store during one uninterrupted observation period. Returning
     * after the last observer left always revalidates because wakes were absent.
     */
    shouldLoadOnObserve: (target: TTarget) => boolean;
    /** Marks the domain's rows for one Home stale. Called before refetching. */
    invalidateServer: (serverId: string) => void;
    /** Marks this exact retained target stale without disturbing sibling rows. */
    invalidateTarget: (target: TTarget) => void;
    /** Filters exact focused-Home wakes. Content-free secondary/socket wakes stay conservative. */
    matchesWake?: (event: HomeAccountChangeEvent) => boolean;
    /**
     * Handles credential replacement/removal at this same refcounted lifecycle owner. Returning
     * true schedules a refresh; false retains the domain state established by the callback.
     */
    onCredentialMutation?: (event: HomeCredentialMutationEvent, target: TTarget) => boolean;
}>): ScopedSnapshotLoader<TTarget> {
    const observed = new Map<string, { target: TTarget; count: number }>();
    const inFlight = new Map<string, Promise<void>>();
    const maintenance = new Map<string, { result: ScopedSnapshotLoadMaintenance; reloadAfterMaintenance: boolean }>();
    /**
     * A target that crossed zero observers cannot remain trusted as current:
     * the wake subscription is deliberately absent during that interval. Keep
     * the domain's last-known-good rows, but force the next first observer to
     * revalidate them even when the store still reports a fresh snapshot.
     */
    const revalidateOnNextObserve = new Set<string>();
    /**
     * Targets woken while their own load was already in flight. That request was
     * issued before the mutation committed, so its answer cannot contain the
     * change, and joining it would consume the only signal about that change.
     * Exactly one trailing reload runs per target; further wakes during it
     * coalesce into the same follow-up.
     */
    const reloadAfterInFlight = new Set<string>();
    let unsubscribeWake: (() => void) | null = null;
    let unsubscribeCredentials: (() => void) | null = null;

    function loadOnce(target: TTarget): Promise<void> {
        const existing = inFlight.get(target.key);
        if (existing) return existing;
        let pending!: Promise<void>;
        pending = (async () => {
            try {
                while (true) {
                    let failure: unknown = null;
                    try {
                        // Enter the load through a microtask so `inFlight` is registered before a
                        // domain reader can either resolve or throw synchronously.
                        const isCurrent = () => !reloadAfterInFlight.has(target.key) && !revalidateOnNextObserve.has(target.key);
                        // Only cleanup that preceded this read can suppress it. After
                        // publication the live map may contain this read's own cleanup.
                        const incumbentMaintenance = maintenance.get(target.key);
                        const hasPendingMaintenance = () => {
                            const incumbent = incumbentMaintenance;
                            if (incumbent?.result.isMaintenanceCurrent() !== true
                                || maintenance.get(target.key) !== incumbent) return false;
                            // This read can include newly activated rows or source roots.
                            // Resume their cleanup after the incumbent settles rather than
                            // treating its older proof as completion for the newer read.
                            incumbent.reloadAfterMaintenance = true;
                            return true;
                        };
                        const result = await Promise.resolve().then(async () => await params.load(observed.get(target.key)?.target ?? target, {
                            isCurrent,
                            async readWithMaintenance({ read, publish, getPublication }) {
                                let finishRead!: () => void;
                                const ready = new Promise<void>(resolve => { finishRead = resolve; });
                                let capturedCurrent: (() => boolean) | null = null;
                                let published: unknown;
                                const completion = read({ hasPendingCleanup: hasPendingMaintenance,
                                    onReady: (projection, isAccountCurrent) => {
                                        capturedCurrent = isAccountCurrent;
                                        publish(projection, isCurrent());
                                        published = getPublication();
                                        finishRead();
                                    },
                                }).then(projection => {
                                    if (!capturedCurrent || (capturedCurrent() && published === getPublication())) {
                                        publish(projection, isCurrent());
                                    }
                                });
                                await Promise.race([ready, completion]);
                                if (capturedCurrent) return { maintenance: completion, isMaintenanceCurrent: capturedCurrent };
                            },
                        }));
                        // A foreground reread can join cleanup already owned by this
                        // captured Account. Its short completion must not replace the
                        // original, still-running cleanup promise.
                        if (result && maintenance.get(target.key)?.result.isMaintenanceCurrent() !== true) {
                            const entry = { result, reloadAfterMaintenance: false };
                            maintenance.set(target.key, entry);
                            void result.maintenance.catch(() => {}).finally(() => {
                                if (maintenance.get(target.key) !== entry) return;
                                maintenance.delete(target.key);
                                if (entry.reloadAfterMaintenance && result.isMaintenanceCurrent()) requestReload(target);
                            });
                        }
                    } catch (error) {
                        failure = error;
                    }
                    if (!reloadAfterInFlight.delete(target.key)) {
                        if (failure !== null) throw failure;
                        return;
                    }
                    // The just-settled request began before the wake/gap. Keep any
                    // last-known answer visible, but never expose its capabilities
                    // as current while the deciding trailing read is pending.
                    params.invalidateTarget(target);
                }
            } finally {
                // Delete the single-flight registration before this exact promise settles.
                // A wake/remount can then either mark the still-running loop for a trailing
                // read or start a new read; it cannot join a request that already chose to exit.
                if (inFlight.get(target.key) === pending) inFlight.delete(target.key);
            }
        })();
        inFlight.set(target.key, pending);
        return pending;
    }

    function targetsForServer(serverId: string): TTarget[] {
        return [...observed.values()]
            .map((entry) => entry.target)
            .filter((target) => areServerProfileIdentifiersEquivalent(target.serverId, serverId));
    }

    function requestReload(target: TTarget): void {
        if (inFlight.has(target.key)) {
            reloadAfterInFlight.add(target.key);
            return;
        }
        void loadOnce(target).catch(() => {});
    }

    function invalidate(target: TTarget): Promise<void> {
        const observedTarget = observed.get(target.key);
        if (observedTarget) observedTarget.target = target;
        params.invalidateTarget(target);
        const existing = inFlight.get(target.key);
        if (existing) {
            reloadAfterInFlight.add(target.key);
            return existing;
        }
        return loadOnce(target);
    }

    function handleWake(serverId: string): void {
        const targets = targetsForServer(serverId);
        if (targets.length === 0) return;
        // Mark the exact Home's rows stale first, so a surface can explain
        // itself before the refetch answers. Other Homes are untouched.
        params.invalidateServer(targets[0]!.serverId);
        for (const target of targets) {
            requestReload(target);
        }
    }

    function ensureLifecycleSubscriptions(): void {
        if (!unsubscribeWake) {
            unsubscribeWake = subscribeHomeAccountChange((event) => {
                if (params.matchesWake && !params.matchesWake(event)) return;
                handleWake(event.serverId);
            });
        }
        if (params.onCredentialMutation && !unsubscribeCredentials) {
            unsubscribeCredentials = subscribeHomeCredentialChange((event) => {
                for (const target of targetsForServer(event.serverId)) {
                    if (params.onCredentialMutation?.(event, target) === true) {
                        requestReload(target);
                    }
                }
            });
        }
    }

    function releaseLifecycleSubscriptionsIfIdle(): void {
        if (observed.size > 0) return;
        unsubscribeWake?.();
        unsubscribeWake = null;
        unsubscribeCredentials?.();
        unsubscribeCredentials = null;
    }

    return {
        observe(target) {
            const entry = observed.get(target.key);
            const returnedAfterObserverGap = !entry && revalidateOnNextObserve.delete(target.key);
            if (entry) {
                entry.count += 1;
            } else {
                observed.set(target.key, { target, count: 1 });
            }
            ensureLifecycleSubscriptions();

            if (returnedAfterObserverGap) {
                // This device heard no wakes while the target had no observer.
                // Retained rows remain useful, but their mutation decisions are
                // withdrawn synchronously before the remounted surface renders.
                params.invalidateTarget(target);
            }
            if (returnedAfterObserverGap && inFlight.has(target.key)) {
                // Joining a read that began before the observer-free interval
                // would not prove currentness after that interval. Let it land
                // for continuity, then immediately revalidate once.
                reloadAfterInFlight.add(target.key);
            } else if (returnedAfterObserverGap || params.shouldLoadOnObserve(target)) {
                void loadOnce(target).catch(() => {});
            }

            let released = false;
            return () => {
                if (released) return;
                released = true;
                const tracked = observed.get(target.key);
                if (!tracked) return;
                tracked.count -= 1;
                if (tracked.count <= 0) {
                    observed.delete(target.key);
                    revalidateOnNextObserve.add(target.key);
                    // Once the last observer leaves, this device also stops
                    // listening for wakes for the target when no sibling keeps
                    // the shared lifecycle alive. Retain the rows for continuity,
                    // but withdraw their currentness immediately so synchronous
                    // readers cannot treat an unobserved projection as fresh.
                    params.invalidateTarget(target);
                    // No background read is useful without a consumer. The
                    // next first observer now owns the revalidation instead.
                    reloadAfterInFlight.delete(target.key);
                }
                releaseLifecycleSubscriptionsIfIdle();
            };
        },
        async refresh(target) {
            await loadOnce(target);
        },
        async invalidate(target) {
            await invalidate(target);
        },
        resetForTests() {
            observed.clear();
            inFlight.clear();
            maintenance.clear();
            reloadAfterInFlight.clear();
            revalidateOnNextObserve.clear();
            unsubscribeWake?.();
            unsubscribeWake = null;
            unsubscribeCredentials?.();
            unsubscribeCredentials = null;
        },
    };
}
