import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
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
    refresh: (target: TTarget, signal?: AbortSignal) => Promise<void>;
    /** Invalidates now and awaits the newest load, including a required trailing reload. */
    invalidate: (target: TTarget) => Promise<void>;
    /** A cursor read shares its observed sequence's cancellation lifetime. */
    readContinuation: (target: TTarget, read: (signal: AbortSignal) => Promise<void>) => Promise<void>;
    resetForTests: () => void;
}>; 

export type ScopedSnapshotLoadContext = Readonly<{
    /** Canceled when demand leaves or this sequence is replaced. Finite reads own their call lifetime. */
    signal: AbortSignal;
    /**
     * Whether this request can publish authority-bearing data as current.
     * A wake or observer gap that happened after the request began makes
     * its answer useful for continuity only; the queued read is authoritative.
     */
    isCurrent: () => boolean;
    /** Publishes a checked read before its retained cleanup, without late obsolete publication. */
    readWithMaintenance: <TProjection>(input: Readonly<{
        read: (publication: ScopedSnapshotReadPublication<TProjection>) => Promise<TProjection>;
        /** Freshness can lapse during a read while its captured Account still admits display data. */
        publish: (projection: TProjection, current: boolean, isAccountCurrent?: () => boolean) => void;
        getPublication: () => unknown;
    }>) => Promise<void>;
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

export type ScopedSnapshotLoad<TTarget> = Readonly<{ target: TTarget; context: ScopedSnapshotLoadContext }>;

export type ScopedSnapshotRetainedInvalidation = Readonly<{
    invalidate: (reason?: 'transport-withdrawal') => void;
    retire: () => void;
}>;

type ScopedSnapshotReader<TTarget> = Readonly<{
    /** Reads the target and publishes the outcome into the domain's store. */
    load: (target: TTarget, context: ScopedSnapshotLoadContext) => Promise<void | ScopedSnapshotLoadMaintenance>;
    loadMany?: never;
    loadGroupKey?: never;
}> | Readonly<{
    load?: never;
    /** Reads the synchronously demanded set before any asynchronous admission. */
    loadMany: (loads: readonly ScopedSnapshotLoad<TTarget>[], signal: AbortSignal) => Promise<void>;
    /** Exact independent read boundary, e.g. captured Account and application. */
    loadGroupKey: (target: TTarget) => string;
}>;

export function createScopedSnapshotLoader<TTarget extends ScopedLoadTarget>(params: ScopedSnapshotReader<TTarget> & Readonly<{
    /**
     * Whether a newly observed target needs a read. The domain decides this from
     * its own store. Without retained invalidation, returning after the last
     * observer left revalidates because wakes were absent.
     */
    shouldLoadOnObserve: (target: TTarget) => boolean;
    /**
     * Account catalogs retain wake/credential invalidation across navigation.
     * Their admission owner pushes withdrawal to synchronous readers and
     * retires this retention with the captured Home/Account scope. Retention
     * creates no connection demand, background reads or mutation authority.
     */
    subscribeRetainedInvalidation?: (target: TTarget, handlers: ScopedSnapshotRetainedInvalidation) => () => void;
    /**
     * false: only a released observation keeps this retention. A finite read (a mutation completion, a one-shot
     * refresh) then takes no wake or credential custody, so a refusal it receives or a write its own maintenance makes
     * cannot supersede it before it publishes.
     */
    retainFiniteReads?: boolean;
    /** Marks the domain's rows for one Home stale. Called before refetching. */
    invalidateServer: (serverId: string) => void;
    /** Marks this exact retained target stale; the domain distinguishes advisory reloads from retirement. */
    invalidateTarget: (target: TTarget, reason: 'reload' | 'explicit' | 'observer-gap') => void;
    /** Filters exact focused-Home wakes. Content-free secondary/socket wakes stay conservative. */
    matchesWake?: (event: HomeAccountChangeEvent) => boolean;
    /** A domain may narrow the demanded rows, or discard an already received revision. */
    prepareWake?: (event: HomeAccountChangeEvent, target: TTarget) => boolean;
    /** Revalidate from the socket wake even while detailed catch-up is unavailable. */
    observeCatchUpPending?: boolean;
    /**
     * Handles credential replacement/removal at this same refcounted lifecycle owner. Returning
     * true schedules a refresh; false retains the domain state established by the callback.
     */
    onCredentialMutation?: (event: HomeCredentialMutationEvent, target: TTarget) => boolean;
}>): ScopedSnapshotLoader<TTarget> {
    const observed = new Map<string, { target: TTarget; count: number }>();
    const retainedTargets = new Map<string, { target: TTarget; unsubscribe: () => void }>();
    const inFlight = new Map<string, Promise<void>>();
    const lifetimes = new Map<string, { controller: AbortController; finiteReads: number }>();
    const maintenance = new Map<string, { result: ScopedSnapshotLoadMaintenance; reloadAfterMaintenance: boolean }>();
    /**
     * A target read without observers, or returning after its observers left, cannot remain trusted as current:
     * the wake subscription is deliberately absent during that interval. Keep
     * the domain's last-known-good rows, but force the next first observer to
     * revalidate them even when the store still reports a fresh snapshot.
     * Finite settlement requests that later revalidation without retroactively
     * retiring the read; an actual observer gap also withdraws its currentness.
     */
    const revalidateOnNextObserve = new Map<string, 'observer-gap' | 'finite-read'>();
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

    type PendingLoad = ScopedSnapshotLoad<TTarget> & {
        resolve: () => void;
        reject: (error: unknown) => void;
    };
    const pendingLoads = new Map<string, PendingLoad[]>();

    function readTarget(target: TTarget, context: ScopedSnapshotLoadContext): Promise<void | ScopedSnapshotLoadMaintenance> {
        const load = params.load;
        if (load) {
            // Incumbent direct publishers serialize their replacement. Catalogs
            // opt into guarded publication and can release an abandoned waiter.
            if (!params.subscribeRetainedInvalidation) return load(target, context);
            return new Promise((resolve, reject) => {
                const detach = () => { context.signal.removeEventListener('abort', finish); };
                const finish = () => { detach(); resolve(); };
                if (context.signal.aborted) { finish(); return; }
                context.signal.addEventListener('abort', finish, { once: true });
                try {
                    void load(target, context).then(result => { detach(); resolve(result); },
                        error => { detach(); reject(error); });
                } catch (error) { detach(); reject(error); }
            });
        }
        const loadMany = params.loadMany;
        const key = params.loadGroupKey(target);
        return new Promise<void>((resolve, reject) => {
            // One target may leave while siblings still need the shared Action.
            // Release its own slot without canceling their result recipient.
            const finish = () => { context.signal.removeEventListener('abort', finish); resolve(); };
            const fail = (error: unknown) => { context.signal.removeEventListener('abort', finish); reject(error); };
            if (context.signal.aborted) { finish(); return; }
            context.signal.addEventListener('abort', finish, { once: true });
            const pending = pendingLoads.get(key);
            if (pending) {
                pending.push({ target, context, resolve: finish, reject: fail });
                return;
            }
            const loads = [{ target, context, resolve: finish, reject: fail }];
            pendingLoads.set(key, loads);
            // Observation, refresh and a wake supply their ready targets in one
            // turn. Collect them here, before settings/approval can split ticks.
            queueMicrotask(() => {
                pendingLoads.delete(key);
                // A set remains useful while any member of it still has demand.
                const lifetime = new AbortController();
                let remaining = 0;
                const withdraw = () => {
                    remaining -= 1;
                    if (remaining === 0) lifetime.abort();
                };
                for (const load of loads) {
                    if (load.context.signal.aborted) continue;
                    remaining += 1;
                    load.context.signal.addEventListener('abort', withdraw, { once: true });
                }
                if (remaining === 0) lifetime.abort();
                void loadMany(loads, lifetime.signal).then(() => {
                    for (const load of loads) load.resolve();
                }, error => { for (const load of loads) load.reject(error); }).finally(() => {
                    for (const load of loads) load.context.signal.removeEventListener('abort', withdraw);
                });
            });
        });
    }

    function loadOnce(target: TTarget): Promise<void> {
        const existing = inFlight.get(target.key);
        if (existing) return existing;
        let pending!: Promise<void>;
        pending = (async () => {
            try {
                while (true) {
                    let failure: unknown = null;
                    // A new demanded read covers the stale mark, including a
                    // mounted observer whose captured admission just retired.
                    // Its replacement read must publish the current refusal.
                    if (retainedTargets.has(target.key) || observed.has(target.key)) revalidateOnNextObserve.delete(target.key);
                    // A deciding first-page read replaces its old cursor sequence.
                    const demand = lifetimes.get(target.key) ?? { controller: new AbortController(), finiteReads: 0 };
                    demand.controller.abort();
                    const lifetime = new AbortController();
                    demand.controller = lifetime;
                    lifetimes.set(target.key, demand);
                    try {
                        // Enter the load through a microtask so `inFlight` is registered before a
                        // domain reader can either resolve or throw synchronously.
                        const isCurrent = () => !lifetime.signal.aborted && !reloadAfterInFlight.has(target.key)
                            && revalidateOnNextObserve.get(target.key) !== 'observer-gap';
                        // Only cleanup that preceded this read can suppress it. After
                        // publication the live map may contain this read's own cleanup.
                        const incumbentMaintenance = maintenance.get(target.key);
                        let joinedIncumbentMaintenance = false;
                        const hasPendingMaintenance = () => {
                            const incumbent = incumbentMaintenance;
                            if (incumbent?.result.isMaintenanceCurrent() !== true
                                || maintenance.get(target.key) !== incumbent) {
                                // This foreground read now owns its own cleanup. It also
                                // satisfies any demand queued on the retired incumbent.
                                if (incumbent) incumbent.reloadAfterMaintenance = false;
                                return false;
                            }
                            joinedIncumbentMaintenance = true;
                            return true;
                        };
                        const result = await Promise.resolve().then(async () => await readTarget(observed.get(target.key)?.target ?? target, {
                            signal: lifetime.signal,
                            isCurrent,
                            async readWithMaintenance({ read, publish, getPublication }) {
                                let finishRead!: () => void;
                                const ready = new Promise<void>(resolve => { finishRead = resolve; });
                                let capturedCurrent: (() => boolean) | null = null;
                                let published: unknown;
                                // Assign completion before invoking read: onReady may
                                // run synchronously and must register its cleanup first.
                                const completion: Promise<void> = Promise.resolve().then(() => read({
                                    hasPendingCleanup: () => lifetime.signal.aborted || hasPendingMaintenance(),
                                    onReady: (projection, isAccountCurrent) => {
                                        if (lifetime.signal.aborted) return;
                                        capturedCurrent = isAccountCurrent;
                                        registerMaintenance(target, { maintenance: completion, isMaintenanceCurrent: isAccountCurrent });
                                        if (isAccountCurrent()) publish(projection, isCurrent(), isAccountCurrent);
                                        published = getPublication();
                                        finishRead();
                                    },
                                })).then(projection => {
                                    if (lifetime.signal.aborted) return;
                                    if (!capturedCurrent || (capturedCurrent() && published === getPublication())) {
                                        publish(projection, isCurrent(), capturedCurrent ?? undefined);
                                    }
                                });
                                await Promise.race([ready, completion]);
                            },
                        }));
                        // An independent foreground pass already serves the demand
                        // retained on older cleanup. Replaying it after this pass
                        // would mark the new cleanup dirty and self-trigger forever.
                        // A reader that joined the incumbent still owes that pass;
                        // wakes during this read remain in reloadAfterInFlight.
                        if (incumbentMaintenance && !joinedIncumbentMaintenance) {
                            incumbentMaintenance.reloadAfterMaintenance = false;
                        }
                        // A foreground reread can join cleanup already owned by this
                        // captured Account. Its short completion must not replace the
                        // original, still-running cleanup promise.
                        if (result) registerMaintenance(target, result);
                    } catch (error) {
                        if (!lifetime.signal.aborted) failure = error;
                    }
                    if (!reloadAfterInFlight.delete(target.key)) {
                        if (failure !== null) throw failure;
                        return;
                    }
                    // The just-settled request began before the wake/gap. Keep any
                    // last-known answer visible, but never expose its capabilities
                    // as current while the deciding trailing read is pending.
                    params.invalidateTarget(target, 'reload');
                }
            } finally {
                // Delete the single-flight registration before this exact promise settles.
                // A wake/remount can then either mark the still-running loop for a trailing
                // read or start a new read; it cannot join a request that already chose to exit.
                if (inFlight.get(target.key) === pending) {
                    inFlight.delete(target.key);
                    if (!observed.has(target.key) && !lifetimes.get(target.key)?.finiteReads) lifetimes.delete(target.key);
                    // A finite borrower can refresh without any wake subscription. Its answer
                    // stays valid for that invocation, but a later first observer must revalidate.
                    if (!observed.has(target.key) && !retainedTargets.has(target.key) && !revalidateOnNextObserve.has(target.key)) {
                        revalidateOnNextObserve.set(target.key, 'finite-read');
                    }
                }
            }
        })();
        inFlight.set(target.key, pending);
        return pending;
    }

    function targetsForServer(serverId: string): TTarget[] {
        const targets = new Map([...retainedTargets].map(([key, entry]) => [key, entry.target] as const));
        for (const [key, entry] of observed) targets.set(key, entry.target);
        return [...targets.values()]
            .filter((target) => areServerProfileIdentifiersEquivalent(target.serverId, serverId));
    }

    function registerMaintenance(target: TTarget, result: ScopedSnapshotLoadMaintenance): void {
        if (maintenance.get(target.key)?.result.isMaintenanceCurrent() === true) return;
        const entry = { result, reloadAfterMaintenance: reloadAfterInFlight.has(target.key) };
        maintenance.set(target.key, entry);
        void result.maintenance.catch(() => {}).finally(async () => {
            if (maintenance.get(target.key) !== entry) return;
            maintenance.delete(target.key);
            // Foreground demand decides whether it joined this cleanup or
            // already served the required pass. Do not feed its own tail back.
            await inFlight.get(target.key)?.catch(() => {});
            if (entry.reloadAfterMaintenance && result.isMaintenanceCurrent()) {
                if (!requireMaintenanceReload(target)) void loadOnce(target).catch(() => {});
            }
        });
    }

    function retireRetainedTarget(target: TTarget): void {
        const retained = retainedTargets.get(target.key);
        if (!retained) return;
        retainedTargets.delete(target.key);
        retained.unsubscribe();
        revalidateOnNextObserve.set(target.key, 'observer-gap');
        params.invalidateTarget(target, 'observer-gap');
        lifetimes.get(target.key)?.controller.abort();
        reloadAfterInFlight.delete(target.key);
        releaseLifecycleSubscriptionsIfIdle();
    }

    function retainInvalidation(target: TTarget): void {
        if (!params.subscribeRetainedInvalidation || retainedTargets.has(target.key)) return;
        const entry = { target, unsubscribe: () => {} };
        retainedTargets.set(target.key, entry);
        const unsubscribe = params.subscribeRetainedInvalidation(target, {
            invalidate: (reason) => {
                if (retainedTargets.get(target.key) !== entry) return;
                // Observed catalogs receive actual changes through their Home
                // wake; a socket gap alone changes no content. Finite readers
                // still lose freshness before their next synchronous use.
                if (reason === 'transport-withdrawal' && observed.has(target.key)) return;
                // Withdraw freshness at the producer event, before any hidden
                // synchronous reader can consume the retained admission.
                params.invalidateTarget(target, 'observer-gap');
                revalidateOnNextObserve.set(target.key, 'observer-gap');
                if (observed.has(target.key) || inFlight.has(target.key)) requestReload(target);
            },
            retire: () => { retireRetainedTarget(target); },
        });
        if (retainedTargets.get(target.key) === entry) entry.unsubscribe = unsubscribe;
        else unsubscribe();
    }

    function requestReload(target: TTarget): void {
        requireMaintenanceReload(target);
        if (inFlight.has(target.key)) {
            reloadAfterInFlight.add(target.key);
            return;
        }
        void loadOnce(target).catch(() => {});
    }

    async function withFiniteDemand(target: TTarget, read: () => Promise<void>): Promise<void> {
        if (params.subscribeRetainedInvalidation && params.retainFiniteReads !== false) {
            // A non-observing consumer (for example Voice) can be the first
            // reader. Its admitted snapshot needs the same withdrawal signals.
            retainInvalidation(target);
            ensureLifecycleSubscriptions();
        }
        const demand = lifetimes.get(target.key) ?? { controller: new AbortController(), finiteReads: 0 };
        demand.finiteReads += 1;
        lifetimes.set(target.key, demand);
        if (!observed.has(target.key)) {
            const abandoned = revalidateOnNextObserve.get(target.key) === 'observer-gap';
            revalidateOnNextObserve.delete(target.key);
            // A new finite borrower cannot revive an already canceled reader.
            // Serialize its own deciding pass after that reader settles.
            if (abandoned && inFlight.has(target.key)) reloadAfterInFlight.add(target.key);
        }
        try { await read(); }
        finally {
            demand.finiteReads -= 1;
            if (!observed.has(target.key) && !inFlight.has(target.key) && demand.finiteReads === 0
                && lifetimes.get(target.key) === demand) lifetimes.delete(target.key);
        }
    }

    async function refresh(target: TTarget, signal?: AbortSignal): Promise<void> {
        throwIfAborted(signal);
        try {
            await withFiniteDemand(target, () => {
                const pending = loadOnce(target);
                return signal ? new Promise<void>((resolve, reject) => {
                    const cleanup = () => signal.removeEventListener('abort', onAbort);
                    const onAbort = () => {
                        cleanup();
                        try { throwIfAborted(signal); } catch (error) { reject(error); }
                    };
                    signal.addEventListener('abort', onAbort, { once: true });
                    if (signal.aborted) onAbort();
                    void pending.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
                }) : pending;
            });
            throwIfAborted(signal);
        } finally {
            const demand = lifetimes.get(target.key);
            if (signal?.aborted && !observed.has(target.key) && demand?.finiteReads === 0) {
                if (inFlight.has(target.key)) revalidateOnNextObserve.set(target.key, 'observer-gap');
                demand.controller.abort();
            }
        }
    }

    function invalidate(target: TTarget): Promise<void> {
        const observedTarget = observed.get(target.key);
        if (observedTarget) observedTarget.target = target;
        params.invalidateTarget(target, 'explicit');
        requireMaintenanceReload(target);
        const existing = inFlight.get(target.key);
        if (existing) {
            reloadAfterInFlight.add(target.key);
            return existing;
        }
        return loadOnce(target);
    }

    function requireMaintenanceReload(target: TTarget): boolean {
        const incumbent = maintenance.get(target.key);
        if (incumbent?.result.isMaintenanceCurrent() === true) {
            // A changed demand can reveal new source/authority after this cleanup
            // started. Ordinary reads joining it do not schedule another pass.
            incumbent.reloadAfterMaintenance = true;
            return true;
        }
        return false;
    }

    function handleWake(event: HomeAccountChangeEvent): void {
        const targets = targetsForServer(event.serverId).filter(target => params.prepareWake?.(event, target) !== false);
        if (targets.length === 0) return;
        // Mark the exact Home's rows stale first, so a surface can explain
        // itself before the refetch answers. Other Homes are untouched.
        if (!params.prepareWake) params.invalidateServer(targets[0]!.serverId);
        for (const target of targets) {
            if (params.prepareWake) params.invalidateTarget(target, 'reload');
            if (observed.has(target.key) || inFlight.has(target.key)) requestReload(target);
            else revalidateOnNextObserve.set(target.key, 'observer-gap');
        }
    }

    function ensureLifecycleSubscriptions(): void {
        if (!unsubscribeWake) {
            unsubscribeWake = subscribeHomeAccountChange((event) => {
                if (params.matchesWake && !params.matchesWake(event)) return;
                handleWake(event);
            }, { includeCatchUpPending: params.observeCatchUpPending, reconnect: 'refresh' });
        }
        if (params.onCredentialMutation && !unsubscribeCredentials) {
            unsubscribeCredentials = subscribeHomeCredentialChange((event) => {
                for (const target of targetsForServer(event.serverId)) {
                    // Credentials replaced/removed the captured admission. Do
                    // not keep signed-out or old-Account targets subscribed.
                    retireRetainedTarget(target);
                    const reload = params.onCredentialMutation?.(event, target) === true;
                    if (reload) {
                        if (observed.has(target.key) || inFlight.has(target.key)) requestReload(target);
                        else revalidateOnNextObserve.set(target.key, 'observer-gap');
                    }
                }
            });
        }
    }

    function releaseLifecycleSubscriptionsIfIdle(): void {
        if (observed.size > 0 || retainedTargets.size > 0) return;
        unsubscribeWake?.();
        unsubscribeWake = null;
        unsubscribeCredentials?.();
        unsubscribeCredentials = null;
    }

    return {
        observe(target) {
            retainInvalidation(target);
            const entry = observed.get(target.key);
            const returnedAfterObserverGap = !entry && (revalidateOnNextObserve.delete(target.key)
                || inFlight.has(target.key) && !retainedTargets.has(target.key));
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
                params.invalidateTarget(target, 'observer-gap');
                requireMaintenanceReload(target);
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
                    // refresh()/invalidate() borrowers own demand until their
                    // shared read answers, even after a surface unmounts.
                    if (lifetimes.get(target.key)?.finiteReads) {
                        releaseLifecycleSubscriptionsIfIdle();
                        return;
                    }
                    const retainsInvalidation = retainedTargets.has(target.key) && !inFlight.has(target.key);
                    if (!retainsInvalidation) revalidateOnNextObserve.set(target.key, 'observer-gap');
                    // A settled catalog keeps its invalidation subscription,
                    // while interrupted reads and domains without that contract
                    // withdraw currentness until their next demanded read.
                    if (!retainsInvalidation) params.invalidateTarget(target, 'observer-gap');
                    // No background read is useful without a consumer. The
                    // next first observer now owns the revalidation instead.
                    reloadAfterInFlight.delete(target.key);
                    lifetimes.get(target.key)?.controller.abort();
                    lifetimes.delete(target.key);
                }
                releaseLifecycleSubscriptionsIfIdle();
            };
        },
        refresh,
        async invalidate(target) {
            await withFiniteDemand(target, () => invalidate(target));
        },
        async readContinuation(target, read) {
            const demand = lifetimes.get(target.key) ?? { controller: new AbortController(), finiteReads: 0 };
            const lifetime = demand.controller;
            lifetimes.set(target.key, demand);
            try {
                await read(lifetime.signal);
            } catch (error) {
                if (!lifetime.signal.aborted) throw error;
            } finally {
                if (!observed.has(target.key) && !inFlight.has(target.key) && !demand.finiteReads && lifetimes.get(target.key) === demand) {
                    lifetimes.delete(target.key);
                }
            }
        },
        resetForTests() {
            for (const lifetime of lifetimes.values()) lifetime.controller.abort();
            lifetimes.clear();
            observed.clear();
            const retained = [...retainedTargets.values()];
            retainedTargets.clear();
            for (const entry of retained) entry.unsubscribe();
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
