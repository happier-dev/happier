import type { Disposable, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { createCoalescedScheduler } from '@happier-dev/plugin-sdk/async';

import type { CorpusQualifiedObservationV1 } from '../corpus/fold/qualify.js';
import { laneObservationsFromWire } from './listWindowWire.js';
import {
    createTriageRefreshCoordinator,
    triageRefreshPacingBlock,
    type TriageRefreshCoordinatorV1,
    type TriageRefreshPassOutcomeV1,
} from '../refresh/refreshCoordinator.js';
import {
    TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS,
    type TriageRefreshPacingBlockV1,
    type TriageRefreshTriggerV1,
} from '../refresh/refreshEligibility.js';

import {
    MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
    triageListRowBudgetV1,
    type TriageListEntriesInputV1,
    type TriageListEntriesResultV1,
} from '../actions/listEntriesProtocol.js';
import {
    TRIAGE_LIST_DEFAULT_LENS_V1,
    foldTriageListWindow,
    triageEntryRowKey,
    MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
    triageListCoverageLanes,
    type TriageListLaneV1,
    type TriageListLensV1,
    type TriageListWindowV1,
} from './listWindow.js';

/**
 * The one mounted PRs & Issues window store.
 *
 * There is exactly one of these per mount, and the shell list, the Composer
 * picker, manual **Refresh** and view demand all read and drive it. That is the
 * whole point: two consumers each holding their own cache would each drive their
 * own source walk, which is the split brain this surface exists to avoid. The
 * seam makes that hard to do by accident — a consumer receives a snapshot and a
 * trigger, never a reader it could call itself.
 *
 * It reuses the platform's Resource state contract rather than inventing a third
 * vocabulary: value, freshness, pending work and error are independent, so a
 * failed refresh reports staleness without erasing the window already on screen
 * (`core/CORPUS.md` §4.4).
 *
 * It is deliberately not a generic cached-parameterized-Action facility. It
 * knows one lens, one window and one refresh vocabulary, exports no cache API,
 * and has no cross-plugin consumer.
 */

export type TriageListWindowErrorV1 = Readonly<{
    code: string;
    message: string;
}>;

/**
 * One configured connection this pass asked and could not read at all.
 *
 * `unavailable` health alone cannot say this. It covers both "the invocation was
 * refused" and "no pass has asked yet", and only the store knows which of the
 * two happened. Publishing the distinction is what lets a surface name the
 * connection instead of blaming the aggregate list read — the store used to
 * write the lane's own message into `error`, and the shell then told a reader
 * "the list could not be read" beside the list.
 */
export type TriageListWindowUnreadableSourceV1 = Readonly<{
    sourceInstanceId: string;
    message: string;
}>;

export type TriageListWindowSnapshotV1 = Readonly<{
    /** The last admitted window. Retained across a failed refresh. */
    window?: TriageListWindowV1;
    freshness: 'unknown' | 'fresh' | 'stale';
    pending: 'idle' | 'initial' | 'refresh';
    /**
     * The aggregate list read itself failed **and produced no window at all**.
     *
     * It belongs to no source: a lane that failed reports itself through the
     * window's own health, and a lane nothing could invoke reports itself
     * through `unreadableSources`. It is never published beside a retained
     * window, because the surface renders it as "the list could not be read" —
     * a sentence that is self-evidently false next to rows the reader can see,
     * and the exact regression this slot has now produced three times. A later
     * aggregate read that fails over a retained window names its connections
     * instead and marks the window stale.
     */
    error?: TriageListWindowErrorV1;
    /** Connections this pass asked and could not read. Omitted when there are none. */
    unreadableSources?: readonly TriageListWindowUnreadableSourceV1[];
    /**
     * The one pacing decision, straight from the refresh coordinator: present
     * only when the last cycle could read **no** configured connection because a
     * source deadline or an aggregate backoff is still running.
     *
     * It is published rather than kept inside the coordinator because a Refresh
     * that silently does nothing is the failure `core/CORPUS.md` §4.2 exists to
     * prevent. Every surface reads this member; none re-derives a narrower answer
     * from lane health, which is how the picker came to report an available
     * Refresh the coordinator was already refusing.
     */
    refreshBlocked?: TriageRefreshPacingBlockV1;
    /**
     * What pressing the section's continuation row would do right now.
     *
     * It is published rather than inferred at the surface because only this
     * store knows the three facts that decide it: whether an append is already
     * running, whether the last one failed, and whether this mount has reached
     * the depth ceiling. A surface that guessed would offer a control that does
     * nothing, which is the failure `core/CORPUS.md` §4.2 names for **Refresh**
     * and which a continuation row has been committing since it was written —
     * it has never been pressable at all.
     *
     * Absent until a surface has acquired the window: load-more is a property of
     * a mounted window, and every arm below would be a claim this store cannot
     * make before one exists — `exhausted` most of all, which would assert every
     * connection finished a walk that never started.
     */
    loadMore?: TriageListLoadMoreV1;
    /** Every configured source instance, including ones with no admitted contribution. */
    configuredSources: TriageListEntriesResultV1['configuredSources'];
}>;

/**
 * Whether this mount can append another bounded window, and what is in the way.
 *
 * `failed` is deliberately its own arm rather than a message: the rows already
 * on screen are untouched by a failed append — the merge keeps every one of them
 * — so the honest presentation is the same list plus an offer to try again, not
 * an error over an empty surface. The named connections that failed are already
 * published through `unreadableSources` and the window's own lane health, so
 * this arm carries no second copy of them.
 */
export type TriageListLoadMoreV1 =
    | Readonly<{ kind: 'available' }>
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'failed' }>
    /** Every configured connection finished its walk; there is nothing to append. */
    | Readonly<{ kind: 'exhausted' }>
    /**
     * The window is incomplete and no connection left a frontier to resume from.
     *
     * It is its own arm because an incomplete RESULT and a resumable FRONTIER
     * are two different facts, and only the second one is a place to continue
     * from. A connection with no admitted contribution, a walk that failed, one
     * the deadline stopped and one whose page violated the contract all leave
     * the window `partial` with nothing to page: reading the coverage claim as
     * the offer published `available`, and every press then deepened the mount
     * by one and re-read page ONE of the connections that did answer — the same
     * rows again, deduped away against the same retained page, until the mount
     * ceiling. Nothing new was ever reachable that way. The reader is told the
     * list is incomplete instead, and **Refresh** is the control that can
     * actually change it.
     */
    | Readonly<{ kind: 'unresumable' }>
    /** This mount holds as many windows as it may. */
    | Readonly<{ kind: 'atCeiling' }>;

export type TriageListWindowStoreV1 = Readonly<{
    getSnapshot(): TriageListWindowSnapshotV1;
    subscribe(listener: () => void): () => void;
    /** The only way a consumer causes provider work. */
    refresh(trigger: TriageRefreshTriggerV1): Promise<void>;
    /**
     * Query/facet changes rebuild from the retained page. Order/Smart-policy
     * changes also reacquire the provider cut once under the new ranking.
     *
     * It deliberately does **not** mark the window stale. That marking existed
     * because the read carried the lens, so a new lens really did leave the
     * retained rows unable to answer it; the read is neutral now, the retained
     * page is exactly as fresh as the cycle that fetched it, and saying
     * otherwise would ask the reader to refresh away a filter they had just
     * applied.
     */
    setLens(lens: TriageListLensV1): void;
    /**
     * Append one more bounded window to this mount, or retry the append that
     * failed.
     *
     * It is the same cycle `refresh` drives, at one greater depth, and not a
     * second acquisition path: the coordinator still paces it, the same merge
     * still keeps what is already retained, and a failure still leaves every
     * row on screen. It reads as explicit user demand — the reader pressed a
     * row — so the shared minimum interval does not refuse it, exactly as it
     * does not refuse **Refresh**.
     *
     * Nothing durable is created. Depth and per-lane continuations are retained
     * only by this mounted store, and a lost process starts at the first window.
     */
    loadMore(): Promise<void>;
    dispose(): void;
}>;

export type TriageListWindowReaderV1 = (
    input: TriageListEntriesInputV1,
    options?: PluginCancellationOptions,
) => Promise<TriageListEntriesResultV1>;

/** The artifact-local currentness facade: an Account retirement cancels the mount. */
export type TriageListWindowLifetimeV1 = Readonly<{
    isCurrent(): boolean;
    onRetire(cancel: () => void): Disposable;
}>;

type LaneState = {
    lane: TriageListLaneV1;
    /** Last-known-good: retained verbatim when the next pass for this lane fails. */
    observations: readonly CorpusQualifiedObservationV1[];
    error: TriageListWindowErrorV1 | null;
    completedAtMs: number | null;
};

type LaneContinuation = NonNullable<TriageListEntriesInputV1['resume']>[number];

function sameConfiguredSourceIdentitySet(
    left: TriageListEntriesResultV1['configuredSources'],
    right: TriageListEntriesResultV1['configuredSources'],
): boolean {
    const leftSourceInstanceIds = new Set(left.map((summary) => summary.sourceInstanceId));
    const rightSourceInstanceIds = new Set(right.map((summary) => summary.sourceInstanceId));
    return leftSourceInstanceIds.size === rightSourceInstanceIds.size
        && [...leftSourceInstanceIds].every((sourceInstanceId) => rightSourceInstanceIds.has(sourceInstanceId));
}

function errorFrom(cause: unknown): TriageListWindowErrorV1 {
    if (cause instanceof Error) {
        return { code: 'plugin_action_failed', message: cause.message };
    }
    return { code: 'plugin_action_failed', message: 'The list could not be read.' };
}

/**
 * What a connection gets told about a pass that never reached it.
 *
 * It is the store's own sentence rather than the host's transport string,
 * because the reader is being told about their connection and a dispatcher
 * message explains nothing about it — the same reason a bare `transient` may
 * not reach them. The cause is not discarded from the aggregate arm: it is what
 * `error` carries when no window exists at all.
 */
const UNREADABLE_IN_THIS_PASS_V1: TriageListWindowErrorV1 = Object.freeze({
    code: 'source_unavailable',
    message: 'The source could not be read in this pass.',
});

/**
 * The reference workload one mount's projection window is designed against.
 *
 * `core/SURFACE.md` §9: "2,000 mixed entries paged into one mount's projection
 * window". It is a product statement, quoted rather than chosen here, and it is
 * the only input the ceiling below has that is not already derived.
 */
const TRIAGE_LIST_REFERENCE_WORKLOAD_ENTRIES_V1 = 2_000;

/**
 * The most bounded windows one mount may append.
 *
 * It is the depth at which the reference workload above is reachable, and it is
 * derived from the explicit per-invocation row cap. Continuations do not reduce
 * that cap: strict JSON Action admission has no aggregate byte quota.
 *
 * Past the ceiling the reader is told the mount is full instead of being
 * offered a control that would keep growing a process-local page without end;
 * nothing about it is durable, and a fresh mount starts at one window.
 *
 * It bounds the process-local projection retained by this mount. Refresh does
 * not pay this depth again: it discards the frontier set and reads page one
 * once, while each Load More advances the retained set by one bounded page.
 */
export const MAX_TRIAGE_MOUNTED_WINDOWS_V1 = Math.ceil(
    TRIAGE_LIST_REFERENCE_WORKLOAD_ENTRIES_V1
    / triageListRowBudgetV1(MAX_TRIAGE_LIST_SOURCE_BATCH_V1),
);

export function createTriageListWindowStore(deps: Readonly<{
    readEntries: TriageListWindowReaderV1;
    nowMs: () => number;
    lens?: TriageListLensV1;
    lifetime?: TriageListWindowLifetimeV1;
    onUnexpectedError?: (error: unknown) => void;
}>): TriageListWindowStoreV1 {
    const listeners = new Set<() => void>();
    const lanes = new Map<string, LaneState>();
    /** Provider frontiers retained only for this mounted store's lifetime. */
    const continuations = new Map<string, LaneContinuation>();
    let lens: TriageListLensV1 = deps.lens ?? TRIAGE_LIST_DEFAULT_LENS_V1;
    let configuredSources: TriageListEntriesResultV1['configuredSources'] = [];
    let configuredSourcesStatus: TriageListEntriesResultV1['configuredSourcesStatus'] = 'complete';
    let window: TriageListWindowV1 | null = null;
    let error: TriageListWindowErrorV1 | null = null;
    let pending: TriageListWindowSnapshotV1['pending'] = 'idle';
    let lastCycleCompletedAtMs: number | null = null;
    let pendingTrigger: TriageRefreshTriggerV1 = 'view';
    /**
     * How many bounded windows this mount holds.
     *
     * It is one integer and lives exactly as long as this store. The matching
     * provider frontiers live in `continuations` for exactly the
     * same mounted lifetime. No page is checkpointed and a remade mount starts
     * at one window with no frontier, which is `INV-03` holding.
     */
    let windowsRequested = 1;
    /** A refresh/order-generation change resets depth at the next cycle boundary. */
    let pagingResetPending = false;
    /** An acquisition-generation change keeps replacing the old cut until a reset read succeeds. */
    let generationReplacementPending = false;
    /** Captured at the cycle boundary so demand queued during a read cannot change that read's mode. */
    let activeCycleIsAppend = false;
    /** Whether successful lanes in this cycle replace, rather than extend, the preceding paging cut. */
    let activeCycleReplacesGeneration = false;
    /** True only when the aggregate invocation produced no trustworthy lane result. */
    let activeCycleAggregateFailed = false;
    /** Whether the running cycle was started by an append rather than a refresh. */
    let appending = false;
    /** Whether the last append ended with a connection this mount could not read. */
    let appendFailed = false;
    let disposed = false;
    let retirement: Disposable | null = null;
    let refreshDeadlineWake: ReturnType<typeof setTimeout> | null = null;
    let snapshot: TriageListWindowSnapshotV1 = Object.freeze({
        freshness: 'unknown',
        pending: 'idle',
        configuredSources: Object.freeze([]),
    });

    /**
     * How large this mount's own page may be, in rows.
     *
     * It is the accumulated depth, not the transport bound: the wire carries one
     * bounded window per invocation and this mount appends them, so the page it
     * folds is as deep as the reader asked for. The fold bounds by the lens it
     * is given (`projection/listWindow.ts`), which is what makes appending
     * visible at all.
     */
    function foldLimit(): number {
        return MAX_TRIAGE_LIST_WINDOW_ROWS_V1 * windowsRequested;
    }

    /**
     * The most one mount retains for a single connection.
     *
     * Deliberately larger than the page it shows, by exactly the most ONE
     * invocation can add. The number that matters is the WIRE bound, not the
     * pass's qualification ceiling: a pass may qualify up to `limit - 1 +
     * pageLimit` observations, but the Action cuts to the row bound before the
     * wire and `laneObservationsFromWire` reads only `result.window.rows`, so at
     * most one window's worth reaches this map per invocation. Keeping a whole
     * extra window of room therefore leaves eviction unable to cut an
     * invocation's own answers and reintroduce the deletion the merge exists to
     * prevent.
     */
    function retainedObservationCapacity(): number {
        return foldLimit() + MAX_TRIAGE_LIST_WINDOW_ROWS_V1;
    }

    function isCurrent(): boolean {
        return !disposed && (deps.lifetime?.isCurrent() ?? true);
    }

    function freshness(): TriageListWindowSnapshotV1['freshness'] {
        if (window === null) return 'unknown';
        if (error !== null || lastCycleCompletedAtMs === null) return 'stale';
        // Every configured connection, not only the ones a pass walked. A
        // connection with no admitted contribution is skipped by the cycle
        // and so leaves no lane behind, and a cycle in which every configured
        // connection was skipped refused nothing — so it stamps. Deriving
        // currentness from the walked lanes alone therefore reported a window
        // as current over a list that had never read one configured source,
        // and, when none of them was available, over a list that had read
        // nothing at all. It is the same intended-versus-walked distinction
        // `triageListCoverageLanes` already makes for coverage, asked here of
        // the passes this mount has merged.
        for (const summary of configuredSources) {
            const lane = lanes.get(summary.sourceInstanceId);
            if (lane === undefined || lane.error !== null) return 'stale';
        }
        return deps.nowMs() - lastCycleCompletedAtMs < TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS
            ? 'fresh'
            : 'stale';
    }

    /**
     * A lane that failed with provider evidence is already named by the window's
     * own health, so it is excluded here: reporting it twice would give the same
     * connection two answers.
     */
    function unreadableSources(): readonly TriageListWindowUnreadableSourceV1[] {
        const unreadable: TriageListWindowUnreadableSourceV1[] = [];
        for (const [sourceInstanceId, state] of lanes) {
            if (state.error === null || state.lane.health.kind === 'failed') continue;
            unreadable.push(Object.freeze({ sourceInstanceId, message: state.error.message }));
        }
        return Object.freeze(unreadable);
    }

    /**
     * Whether a **Refresh** press could read any configured connection right now.
     *
     * It asks the one refresh coordinator rather than inspecting lane failures,
     * and it asks as the `manual` trigger because that is the question a Refresh
     * control is asking. The answer is derived on read like freshness, so a
     * deadline that has passed stops being a refusal without waiting for a cycle
     * to overwrite it, and a deadline set by a failure is visible before the user
     * spends a click discovering it.
     *
     * One eligible connection is enough for a refresh to be worth pressing; only
     * when every one of them is refused is the press a no-op the reader must be
     * told about. Several refusals report the furthest deadline, because an
     * earlier one would re-enable a Refresh the next evaluation refuses again.
     */
    function refreshBlock(): TriageRefreshPacingBlockV1 | null {
        let latest: TriageRefreshPacingBlockV1 | null = null;
        for (const summary of configuredSources) {
            if (!summary.available) continue;
            const blocked = coordinator.pacingBlock({
                sourceInstanceId: summary.sourceInstanceId,
                trigger: 'manual',
            });
            if (blocked === null) return null;
            if (latest === null || blocked.nextEligibleAtMs > latest.nextEligibleAtMs) latest = blocked;
        }
        return latest;
    }

    /**
     * One wake for every published fact whose next transition is clock-owned.
     *
     * Eligibility still belongs entirely to the coordinator and freshness to
     * this store. This timer decides neither: it only republishes at the earlier
     * of their existing deadlines so mounted subscribers observe the derived
     * transition. The callback then schedules the same single wake for whatever
     * deadline remains; replacement and disposal cancel it.
     */
    function scheduleRefreshDeadlineWake(blocked: TriageRefreshPacingBlockV1 | null): void {
        if (refreshDeadlineWake !== null) {
            clearTimeout(refreshDeadlineWake);
            refreshDeadlineWake = null;
        }
        if (disposed) return;
        const freshnessDeadline = lastCycleCompletedAtMs !== null && freshness() === 'fresh'
            ? lastCycleCompletedAtMs + TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS
            : null;
        const nextDeadline = blocked === null
            ? freshnessDeadline
            : freshnessDeadline === null
                ? blocked.nextEligibleAtMs
                : Math.min(blocked.nextEligibleAtMs, freshnessDeadline);
        if (nextDeadline === null) return;
        refreshDeadlineWake = setTimeout(() => {
            refreshDeadlineWake = null;
            if (isCurrent()) publish();
        }, Math.max(0, nextDeadline - deps.nowMs()));
    }

    /**
     * What pressing the continuation row would do, in the order the answers
     * override each other, or `null` when there is nothing to append to.
     *
     * A running append outranks everything, because the reader is looking at
     * the thing they just asked for. A failed one outranks the ceiling and the
     * exhaustion claim, because retrying is the offer that failure earns and
     * neither of those two facts is established by a read that did not finish.
     * Exhaustion is read from the window's own coverage claim rather than
     * re-derived from lanes, so this answer and the row's own existence cannot
     * disagree about whether the walk is finished.
     *
     * `null` before a window exists, for the reason the snapshot member states:
     * load-more is a property of an assembled window, every arm below would be
     * a claim this store cannot make before one exists, and `available` would
     * be the worst of them — `loadMore()` refuses a mount with no window, so
     * publishing that arm offered a control this store had already decided to
     * do nothing about.
     */
    function loadMore(): TriageListLoadMoreV1 | null {
        if (window === null) return null;
        if (appending) return Object.freeze({ kind: 'loading' });
        if (appendFailed) return Object.freeze({ kind: 'failed' });
        if (window.coverage === 'complete') return Object.freeze({ kind: 'exhausted' });
        // Incomplete is not the same as resumable. A deeper window re-reads this
        // mount's depth and asks each lane to continue from where it stopped, so
        // with no lane holding a frontier the press would re-read page one and
        // deliver rows the merge already holds.
        if (!anyLaneHoldsFrontier()) return Object.freeze({ kind: 'unresumable' });
        if (windowsRequested >= MAX_TRIAGE_MOUNTED_WINDOWS_V1) return Object.freeze({ kind: 'atCeiling' });
        return Object.freeze({ kind: 'available' });
    }

    /** Whether any lane stopped holding a page a deeper window could continue from. */
    function anyLaneHoldsFrontier(): boolean {
        return continuations.size > 0;
    }

    /**
     * Settle the append this cycle was driving, whichever way the cycle ended.
     *
     * Every exit a started cycle can take passes through here, and that is the
     * point: an append left outstanding is a continuation row stuck reporting a
     * read that is not running, and — because the store's own `loadMore()` only
     * refuses while one IS running — a second press would then deepen the mount
     * past a window it never received.
     *
     * A failure keeps the depth it already asked for and offers a retry rather
     * than a second increment: retrying is the honest response to a read that
     * failed, and deepening again would ask for a window after one that never
     * arrived.
     */
    function settleAppend(failed: boolean, cycleWasAppend: boolean): void {
        if (!cycleWasAppend) return;
        appendFailed = failed;
        appending = false;
    }

    function publish(): void {
        const unreadable = unreadableSources();
        const blocked = refreshBlock();
        scheduleRefreshDeadlineWake(blocked);
        const appendable = loadMore();
        snapshot = Object.freeze({
            ...(window === null ? {} : { window }),
            freshness: freshness(),
            pending,
            ...(appendable === null ? {} : { loadMore: appendable }),
            // The one gate on the store-wide slot, and the reason it is here
            // rather than at each writer: "the list could not be read" is only
            // true while there is no list. A writer that forgets this puts that
            // sentence beside rows the reader is looking at, which is the
            // failure this slot has produced three times. It still holds the
            // retained error internally, so freshness never claims a window is
            // current after a read that failed.
            ...(error === null || window !== null ? {} : { error }),
            ...(unreadable.length === 0 ? {} : { unreadableSources: unreadable }),
            ...(blocked === null ? {} : { refreshBlocked: blocked }),
            configuredSources,
        });
        for (const listener of [...listeners]) listener();
    }

    /**
     * Freshness is the one snapshot member that ages on its own clock, so it is
     * re-derived on read. The cached object is replaced only when the derived
     * value actually differs, because a store that returned a new object on
     * every read would make an external-store subscriber loop forever.
     */
    function readSnapshot(): TriageListWindowSnapshotV1 {
        const current = freshness();
        if (current !== snapshot.freshness) snapshot = Object.freeze({ ...snapshot, freshness: current });
        const blocked = refreshBlock();
        if (blocked === null) {
            if (snapshot.refreshBlocked !== undefined) {
                const { refreshBlocked: expired, ...rest } = snapshot;
                void expired;
                snapshot = Object.freeze(rest);
            }
        } else if (snapshot.refreshBlocked?.reason !== blocked.reason
            || snapshot.refreshBlocked.nextEligibleAtMs !== blocked.nextEligibleAtMs) {
            snapshot = Object.freeze({ ...snapshot, refreshBlocked: blocked });
        }
        return snapshot;
    }

    function rebuild(): void {
        const observations: CorpusQualifiedObservationV1[] = [];
        const walked: TriageListLaneV1[] = [];
        for (const lane of lanes.values()) {
            observations.push(...lane.observations);
            walked.push(lane.lane);
        }
        window = foldTriageListWindow({
            observations,
            // Every configured source is a lane of this window, including one no
            // pass could ask: this mount set out to cover it either way.
            lanes: triageListCoverageLanes({ intended: configuredSources, walked }),
            configuredSourcesStatus,
            activeSourceInstanceIds: configuredSources
                .filter((summary) => summary.available)
                .map((summary) => summary.sourceInstanceId),
            // The reader's lens, at this mount's own accumulated depth. The
            // lens's `limit` is the shell's copy of the TRANSPORT bound, which
            // is the right size for one invocation and the wrong size for a
            // mount that has appended several; taking it here would make every
            // appended window invisible while still paying for it.
            lens: { ...lens, limit: foldLimit() },
            assembledAtMs: deps.nowMs(),
        });
    }

    /**
     * The neutral provider read this mount projects every lens from.
     *
     * The lens is deliberately **not** a parameter of it. The Action folds the
     * pass through the same projection owner this store rebuilds with, so a
     * lens sent into the read drops the excluded rows before they ever reach
     * the wire — and this mount retains only what came back. A refresh taken
     * while the reader had narrowed the list therefore deleted the excluded
     * entries from the mount, and clearing the filter afterwards could not
     * bring them back without another provider read: the reader narrowed,
     * widened, and their entries were silently gone.
     *
     * So the chain runs one way only — provider page, retained raw lane, local
     * lens projection in `rebuild` — and the read asks for no query and no
     * filters at all. `limit` and `order` are required members, and they are
     * the window owner's own defaults rather than a second pair of numbers.
     *
     * `limit` costs nothing: the shell's lens already took it from the window
     * owner (`ui/shell/lens.ts` reads `MAX_TRIAGE_LIST_WINDOW_ROWS_V1`), so the
     * page this mount asks for is byte-identical to the one it asked for
     * before — same `pageLimit`, same observation budget, same provider walk.
     *
     * `order` is the one decision this read takes over from the reader's lens,
     * and it is **not** inert. The Action's observation budget stops the pass's
     * *rotation*; it does not cap a page (`projection/scanPass.ts` checks it
     * before asking for a page, never while adopting one), so a single-instance
     * walk whose source pages short can qualify up to `limit - 1 + pageLimit`
     * observations — 111 at today's 56 — and `foldTriageListWindow` then cuts
     * them to `limit` rows *after* applying the lens it was given. Two costs
     * follow, both bounded by that over-delivery and both visible rather than
     * silent: a cut window is `coverage: 'partial'`, and `retainedLane` is what
     * carries that verdict into this mount's own rebuilt window rather than
     * letting the rebuild re-derive a completeness the page it kept cannot
     * support:
     *
     *  - the retained page is the *newest* rows of what came back, so a reader
     *    looking oldest-first sees the oldest of those, not the oldest the
     *    provider holds;
     *  - a filter is applied to those rows here rather than to the whole walk
     *    at the Action, so a narrow lens over a deep connection can match
     *    fewer rows than a lens-carrying read would have returned.
     *
     * That is the trade this function exists to make. A page fetched under the
     * reader's own lens cannot be re-projected through any other one, so paying
     * for it in depth is paying once; paying for it in destroyed rows was
     * paying every time the reader touched a filter.
     *
     * This is what the *mounted* store sends. The Action's parameters are
     * untouched, and a stateless caller that genuinely wants one filtered
     * answer still asks for one.
     */
    function scanInputFor(
        sourceInstanceIds: readonly string[],
        /**
         * The frontier set this invocation resumes from, already paired with the
         * lanes it belongs to.
         *
         * It is the caller's set rather than one token this function fans out
         * over `sourceInstanceIds`, because a continuation belongs to the walk
         * that produced it: handing the same token to every named connection is
         * exactly the confusion the per-lane map exists to make impossible.
         */
        resume?: TriageListEntriesInputV1['resume'],
    ): TriageListEntriesInputV1 {
        return {
            v: 1,
            sources: { kind: 'selected', sourceInstanceIds },
            /*
             * Where the preceding mounted window stopped, when this is Load
             * More.
             *
             * The mounted store retains it only until the next Load More,
             * Refresh, acquisition-ranking change, or unmount. That is enough to
             * make Load More linear without minting durable cursor custody.
             */
            ...(resume === undefined ? {} : { resume }),
            limit: TRIAGE_LIST_DEFAULT_LENS_V1.limit,
            /*
             * `order` IS sent, while `query` and the facets are not, and the
             * difference is not a hedge — the two kinds of lens member fail in
             * opposite directions.
             *
             * `query` and the facets EXCLUDE rows. Asking the provider to apply
             * them throws away entries that widening the filter should bring
             * back with no further read, which is the defect this store was
             * changed to fix.
             *
             * `order` excludes nothing. It RANKS, and the window ranks before it
             * bounds (`rankCorpusWindow` then `boundAcrossSourceLanes` in
             * `listWindow.ts`), so whichever order is in force at the cut decides
             * WHICH rows survive it. Sending a fixed order hands a reader on
             * `oldest` the NEWEST page re-sorted ascending, and no local re-sort
             * can recover the older entries already cut away — the exact loss
             * keeping it local was meant to prevent.
             */
            order: lens.order,
            smartPolicy: lens.smartPolicy,
        };
    }

    /**
     * The Collection-only Action page that discovers the durable source set.
     *
     * It uses the same Action and same mounted acquisition owner as a scan, but
     * asks for zero rows so the Action returns its configured-source transport
     * batch without reaching a provider. The opaque cursor stays only in this
     * running cycle; it is neither a second cache nor durable paging custody.
     */
    function configuredSourcePageInput(cursor?: string): TriageListEntriesInputV1 {
        return {
            v: 1,
            sources: {
                kind: 'allConfigured',
                ...(cursor === undefined ? {} : { cursor }),
            },
            limit: 0,
            order: lens.order,
            smartPolicy: lens.smartPolicy,
        };
    }

    async function enumerateConfiguredSources(): Promise<Readonly<{
        configuredSources: TriageListEntriesResultV1['configuredSources'];
        configuredSourcesStatus: 'complete';
    }>> {
        const all: TriageListEntriesResultV1['configuredSources'][number][] = [];
        let cursor: string | undefined;
        do {
            const result = await deps.readEntries(configuredSourcePageInput(cursor));
            all.push(...result.configuredSources);
            if (result.configuredSourcesStatus === 'complete') {
                if (result.configuredSourcesNextCursor !== undefined) {
                    throw new Error('Configured-source enumeration returned a cursor after its final page.');
                }
                cursor = undefined;
            } else {
                if (result.configuredSourcesNextCursor === undefined) {
                    throw new Error('Configured-source enumeration truncated without a continuation cursor.');
                }
                cursor = result.configuredSourcesNextCursor;
            }
        } while (cursor !== undefined);
        return Object.freeze({
            configuredSources: Object.freeze(all),
            configuredSourcesStatus: 'complete',
        });
    }

    /**
     * Reset the one mounted page generation.
     *
     * A configured-source identity change invalidates every frontier together:
     * a new source cannot inherit another source's depth, and a removed source
     * must not leave a retained page claiming the old mixed cut is current.
     * Keeping this at the store boundary preserves one acquisition owner rather
     * than giving a caller a separate reset path.
     */
    function resetPagingGeneration(input: Readonly<{ replacesGeneration: boolean }>): void {
        windowsRequested = 1;
        continuations.clear();
        pagingResetPending = false;
        appendFailed = false;
        appending = false;
        if (input.replacesGeneration) generationReplacementPending = true;
    }

    function syncConfiguredSources(
        nextConfiguredSources: TriageListEntriesResultV1['configuredSources'],
        nextConfiguredSourcesStatus: TriageListEntriesResultV1['configuredSourcesStatus'],
    ): boolean {
        const identitySetChanged = !sameConfiguredSourceIdentitySet(
            configuredSources,
            nextConfiguredSources,
        );
        configuredSources = nextConfiguredSources;
        configuredSourcesStatus = nextConfiguredSourcesStatus;
        const known = new Set(nextConfiguredSources.map((summary) => summary.sourceInstanceId));
        for (const sourceInstanceId of [...lanes.keys()]) {
            if (known.has(sourceInstanceId)) continue;
            // The row is gone or retired: drop its lane and abort any pass it
            // still owns. A retired instance's late result must not reach the
            // window it no longer belongs in.
            lanes.delete(sourceInstanceId);
            continuations.delete(sourceInstanceId);
            coordinator.retire(sourceInstanceId);
        }
        return identitySetChanged;
    }

    /**
     * One mixed transport page.
     *
     * Refresh begins without a frontier. Load More resumes the frontier set the
     * preceding page returned, once. Keeping that set in this mounted store is
     * what makes depth linear without creating a durable paging owner.
     */
    async function runPass(input: Readonly<{
        sourceInstanceIds: readonly string[];
        signal: AbortSignal;
    }>): Promise<readonly Readonly<{
        sourceInstanceId: string;
        outcome: TriageRefreshPassOutcomeV1;
    }>[]> {
        const admitted = new Map<string, CorpusQualifiedObservationV1[]>();
        const settled = new Map<string, TriageListLaneV1>();
        const outcomes = new Map<string, TriageRefreshPassOutcomeV1>();
        for (const sourceInstanceId of input.sourceInstanceIds) admitted.set(sourceInstanceId, []);
        for (
            let offset = 0;
            offset < input.sourceInstanceIds.length;
            offset += MAX_TRIAGE_LIST_SOURCE_BATCH_V1
        ) {
            if (!isCurrent() || input.signal.aborted) {
                for (const sourceInstanceId of input.sourceInstanceIds) {
                    if (!outcomes.has(sourceInstanceId)) outcomes.set(sourceInstanceId, { kind: 'interrupted' });
                }
                return input.sourceInstanceIds.map((sourceInstanceId) => ({
                    sourceInstanceId,
                    outcome: outcomes.get(sourceInstanceId) ?? { kind: 'interrupted' },
                }));
            }
            const sourceInstanceIds = input.sourceInstanceIds.slice(
                offset,
                offset + MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
            );
            const resume = activeCycleIsAppend
                ? sourceInstanceIds.flatMap((sourceInstanceId) => {
                    const continuation = continuations.get(sourceInstanceId);
                    return continuation === undefined ? [] : [continuation];
                })
                : undefined;

            let result: TriageListEntriesResultV1;
            try {
                result = await deps.readEntries(
                    scanInputFor(sourceInstanceIds, resume),
                    { signal: input.signal },
                );
            } catch (cause) {
                activeCycleAggregateFailed = true;
                for (const sourceInstanceId of sourceInstanceIds) {
                    if (!input.signal.aborted) {
                        recordLaneError(
                            sourceInstanceId,
                            errorFrom(cause),
                            admitted.get(sourceInstanceId) ?? [],
                        );
                    }
                    outcomes.set(sourceInstanceId, { kind: 'interrupted' });
                }
                continue;
            }
            if (!isCurrent() || input.signal.aborted) {
                for (const sourceInstanceId of input.sourceInstanceIds) {
                    if (!outcomes.has(sourceInstanceId)) outcomes.set(sourceInstanceId, { kind: 'interrupted' });
                }
                return input.sourceInstanceIds.map((sourceInstanceId) => ({
                    sourceInstanceId,
                    outcome: outcomes.get(sourceInstanceId) ?? { kind: 'interrupted' },
                }));
            }

            const nextContinuations = new Map(
                (result.window.continuations ?? []).map((entry) => [entry.sourceInstanceId, entry]),
            );
            for (const sourceInstanceId of sourceInstanceIds) {
                continuations.delete(sourceInstanceId);
                const next = nextContinuations.get(sourceInstanceId);
                if (next !== undefined) continuations.set(sourceInstanceId, next);

                const lane = result.window.lanes.find(
                    (candidate) => candidate.sourceInstanceId === sourceInstanceId,
                );
                const laneObservations = admitted.get(sourceInstanceId) ?? [];
                laneObservations.push(...laneObservationsFromWire(result, sourceInstanceId));
                admitted.set(sourceInstanceId, laneObservations);
                if (lane === undefined) {
                    outcomes.set(sourceInstanceId, { kind: 'interrupted' });
                    continue;
                }
                if (lane.health.kind === 'failed') {
                    recordLaneFailure(sourceInstanceId, lane, {
                        code: lane.health.failure.code,
                        message: lane.health.failure.detail ?? lane.health.failure.class,
                    }, laneObservations);
                    outcomes.set(sourceInstanceId, { kind: 'failed', failure: lane.health.failure });
                    continue;
                }
                if (lane.health.kind === 'unavailable') {
                    recordLaneFailure(sourceInstanceId, lane, UNREADABLE_IN_THIS_PASS_V1, laneObservations);
                    outcomes.set(sourceInstanceId, { kind: 'interrupted' });
                    continue;
                }
                settled.set(sourceInstanceId, retainedLane(lane, result));
                outcomes.set(sourceInstanceId, { kind: 'completed' });
            }
        }

        for (const sourceInstanceId of input.sourceInstanceIds) {
            const lane = settled.get(sourceInstanceId);
            if (lane === undefined) continue;
            const laneObservations = admitted.get(sourceInstanceId) ?? [];
            lanes.set(sourceInstanceId, {
                lane,
                observations: activeCycleReplacesGeneration || lane.exhausted
                    ? laneObservations
                    : retainObservations(lanes.get(sourceInstanceId)?.observations ?? [], laneObservations),
                error: null,
                completedAtMs: deps.nowMs(),
            });
        }
        return input.sourceInstanceIds.map((sourceInstanceId) => ({
            sourceInstanceId,
            outcome: outcomes.get(sourceInstanceId) ?? { kind: 'interrupted' },
        }));
    }

    /**
     * The lane fact this mount retains, corrected for what the wire could carry.
     *
     * A lane may report a settled end of its walk and still have qualified more
     * observations than one window carries: the Action folds the pass through
     * the same projection owner and cuts it to the row bound *before* the wire,
     * and this mount retains only what came back. The Action says so — a cut
     * window is `coverage: 'partial'` — but that claim describes the Action's
     * window, and this mount rebuilds its own from the lanes it has merged. Let
     * `exhausted` through unchanged and a single connection that over-delivered
     * tells the reader every configured source answered, over a list missing
     * the rows that were cut, with nothing to error on.
     *
     * The correction is made on `exhausted` because that is the one member the
     * coverage owner reads (`projection/listWindow.ts`), so the fold stays the
     * single decision-maker instead of gaining a second coverage rule beside
     * it. Reading `coverage` back is exact here rather than a guess: this pass
     * asks one instance, so its window has exactly one lane, and with the
     * configured set carried whole and that lane exhausted the only term left
     * that can make it partial is the cut itself.
     */
    function retainedLane(lane: TriageListLaneV1, result: TriageListEntriesResultV1): TriageListLaneV1 {
        void result;
        return lane;
    }

    /**
     * A failed lane keeps the entries it last admitted **and adopts the ones
     * this pass admitted before it failed**; only its health changes.
     *
     * A walk that fails part way through still answered for the pages it
     * answered for. The pass owner retains them deliberately — an unanswered
     * page says nothing about the ones that answered (`projection/scanPass.ts`)
     * — and the aggregate carries them back in the same result whose lane is
     * marked failed. Reading only the health and keeping the previous
     * observations therefore deleted rows the provider had already given: on a
     * cold scan there is no last-known-good behind them, so page one succeeding
     * and page two timing out made every page-one row disappear from the list.
     *
     * The two are merged on the canonical entry reference through the fold's
     * own row key rather than a second join spelled here, so an entry this pass
     * re-read replaces its retained answer instead of listing twice, and an
     * entry the failed walk never reached keeps the answer it last gave.
     *
     * A settling pass no longer replaces this set wholesale — that replacement
     * was deriving absence by set complement — so the bound it used to supply
     * is now `retainObservations`'s explicit capacity instead.
     */
    function recordLaneFailure(
        sourceInstanceId: string,
        lane: TriageListLaneV1,
        laneError: TriageListWindowErrorV1,
        admitted: readonly CorpusQualifiedObservationV1[],
    ): void {
        const previous = lanes.get(sourceInstanceId);
        lanes.set(sourceInstanceId, {
            lane,
            observations: retainObservations(previous?.observations ?? [], admitted),
            error: laneError,
            completedAtMs: previous?.completedAtMs ?? null,
        });
    }

    /**
     * Last-known-good, with this pass's admitted answers layered over it by
     * entry identity, bounded.
     *
     * Merging is what stops a bounded page from deleting entries it did not
     * name, and the bound is what stops merging from retaining forever. The
     * capacity is deliberately larger than the most one pass can put here,
     * which is the wire bound of 56 rather than the 111 a pass may qualify
     * before the fold cuts it, so eviction can never cut a pass's own answers
     * and reintroduce the loss this merge exists to prevent.
     *
     * Eviction is CACHE eviction and nothing more: an evicted entry is dropped
     * from this mount's retained page, never recorded as `absent`, and the next
     * pass that names it brings it straight back. Only entries this pass did
     * NOT re-observe are ever evicted, oldest first, which is why the layering
     * below re-inserts a re-observed entry at the back rather than leaving it
     * at the position it first appeared in.
     */
    function retainObservations(
        retained: readonly CorpusQualifiedObservationV1[],
        admitted: readonly CorpusQualifiedObservationV1[],
    ): readonly CorpusQualifiedObservationV1[] {
        if (admitted.length === 0) return retained;
        const merged = new Map<string, CorpusQualifiedObservationV1>();
        for (const observation of retained) merged.set(triageEntryRowKey(observation.entryRef), observation);
        for (const observation of admitted) {
            const key = triageEntryRowKey(observation.entryRef);
            // Re-inserted at the back: insertion order is what eviction reads,
            // and this pass's answers must be the last thing it would drop.
            merged.delete(key);
            merged.set(key, observation);
        }
        const values = [...merged.values()];
        const capacity = retainedObservationCapacity();
        return Object.freeze(
            values.length <= capacity ? values : values.slice(values.length - capacity),
        );
    }

    /**
     * A lane whose invocation never settled into provider evidence at all — a
     * rejected Action, a transport failure, or a result the published schema
     * refused.
     *
     * The retained error is kept even for a lane that never succeeded, and that
     * is the whole point: the store-wide `error` is cleared by the *next*
     * cycle's successful enumeration, and a coalesced cycle whose per-instance
     * pass is skipped by the shared minimum interval never re-sets it. Without a
     * retained lane fact the window then reported `fresh` while one configured
     * connection could not be read at all, so the surface said "Up to date" over
     * a list that was missing a whole source.
     *
     * Its health stays `unavailable` rather than `failed`, because a rejected
     * invocation is not provider evidence about the source (`core/CORPUS.md`
     * §4.4). It is the freshness and coverage claims that must stop being made,
     * not the source that must be blamed.
     *
     * The lane fact is published as `unreadableSources` and never as the
     * store-wide `error`. Those are two different failures: this one names a
     * connection, that one is the aggregate read itself failing.
     */
    function recordLaneError(
        sourceInstanceId: string,
        laneError: TriageListWindowErrorV1,
        /**
         * What this cycle's earlier bounded invocations already delivered for
         * this connection, when the rejected one was not the first. They are
         * kept for the same reason a failed lane keeps its own answered pages:
         * an invocation the dispatcher refused says nothing about the ones it
         * carried.
         */
        admitted: readonly CorpusQualifiedObservationV1[] = [],
    ): void {
        const previous = lanes.get(sourceInstanceId);
        if (previous !== undefined) {
            lanes.set(sourceInstanceId, {
                ...previous,
                observations: retainObservations(previous.observations, admitted),
                error: laneError,
            });
        } else {
            const summary = configuredSources.find(
                (candidate) => candidate.sourceInstanceId === sourceInstanceId,
            );
            if (summary !== undefined) {
                lanes.set(sourceInstanceId, {
                    lane: Object.freeze({
                        sourceInstanceId,
                        source: summary.source,
                        health: Object.freeze({ kind: 'unavailable' as const }),
                        exhausted: false,
                    }),
                    observations: retainObservations([], admitted),
                    error: laneError,
                    completedAtMs: null,
                });
            }
        }
    }

    const coordinator: TriageRefreshCoordinatorV1 = createTriageRefreshCoordinator({
        runPass,
        nowMs: deps.nowMs,
        ...(deps.onUnexpectedError ? { onUnexpectedError: deps.onUnexpectedError } : {}),
    });

    async function runCycle(): Promise<void> {
        if (!isCurrent()) return;
        let cycleWasAppend = appending && !pagingResetPending;
        activeCycleIsAppend = cycleWasAppend;
        activeCycleReplacesGeneration = generationReplacementPending && !cycleWasAppend;
        activeCycleAggregateFailed = false;
        const trigger = pendingTrigger;
        // Consumed by the cycle that carries it. Manual **Refresh** is the one
        // trigger the shared minimum interval does not refuse, and leaving it
        // raised handed that exemption to every later view demand — a remount, a
        // focus, a visibility change — so the pacing the interval exists to
        // impose stopped applying the moment a reader pressed Refresh once.
        // Demand that arrives WHILE this cycle runs re-raises it through
        // `refresh`/`loadMore` below, so a manual press queued behind a running
        // cycle still reaches the next one.
        pendingTrigger = 'view';
        pending = window === null ? 'initial' : 'refresh';
        publish();

        try {
            // Enumerating configured instances is a Collection read; it reaches no
            // provider, which is what lets a cold mount and the Composer picker
            // be visibly unsynchronized instead of falsely empty.
            const enumeration = await enumerateConfiguredSources();
            if (!isCurrent()) return;
            const configuredSourceIdentityChanged = syncConfiguredSources(
                enumeration.configuredSources,
                enumeration.configuredSourcesStatus,
            );
            if (configuredSourceIdentityChanged && window !== null) {
                // This check runs before asking the coordinator, so the first
                // post-change invocation includes every available source with
                // no predecessor frontier from the old mixed set.
                resetPagingGeneration({ replacesGeneration: true });
                cycleWasAppend = false;
                activeCycleIsAppend = false;
                activeCycleReplacesGeneration = true;
            }
            error = null;
        } catch (cause) {
            error = errorFrom(cause);
            // Nothing was read, so every connection this cycle was about to ask
            // is a connection it could not read. Naming them is what
            // `core/SURFACE.md` §6.2 row 4 asks for over a retained window, and
            // it is truthful for the same reason a rejected per-lane invocation
            // is: the pass reached no provider evidence about any of them. Only
            // instances the cycle would actually have asked are named — one no
            // pass would have touched must not be accused.
            for (const summary of configuredSources) {
                if (!summary.available) continue;
                recordLaneError(summary.sourceInstanceId, UNREADABLE_IN_THIS_PASS_V1);
            }
            // The cycle an append was driving ended here, so the append ended
            // here too. Leaving it outstanding left the reader a continuation
            // row reporting a read that had already given up.
            settleAppend(true, cycleWasAppend);
            pending = 'idle';
            publish();
            return;
        }

        const request = coordinator.request({
            sourceInstanceIds: configuredSources
                .filter((summary) => summary.available && (
                    !cycleWasAppend || continuations.has(summary.sourceInstanceId)
                ))
                .map((summary) => summary.sourceInstanceId),
            trigger,
        });
        if (pagingResetPending) {
            // This reset intent belongs to this refresh cycle whether or not
            // pacing admits a provider read. Carrying it into a later Load More
            // turns that append into a refresh and restarts every lane from
            // page one. Only an admitted acquisition replaces the frontier;
            // a paced-away cycle consumes the intent while preserving custody.
            pagingResetPending = false;
            if (request.disposition === 'started') {
                resetPagingGeneration({ replacesGeneration: false });
            }
        }
        await request.settled;
        if (request.disposition !== 'blocked' && isCurrent()) {
            rebuild();
            publish();
        }
        const refusals = request.blocked.map((entry) => triageRefreshPacingBlock(entry.reason));

        if (!isCurrent()) return;
        // A cycle in which every requested connection was refused read no
        // provider at all. Stamping it would extend the fresh window without a
        // read, and publishing nothing would leave the reader believing the
        // Refresh they pressed happened.
        const askedNobody = refusals.length > 0 && refusals.every((refusal) => refusal !== null);
        if (!askedNobody) lastCycleCompletedAtMs = deps.nowMs();
        if (
            activeCycleReplacesGeneration
            && request.blocked.length === 0
            && !activeCycleAggregateFailed
            && configuredSources
                .filter((summary) => summary.available)
                .every((summary) => lanes.get(summary.sourceInstanceId)?.error === null)
        ) {
            generationReplacementPending = false;
        }
        // A trustworthy mixed result advances every healthy frontier it carries.
        // Per-lane failures stay on their own lane; only a refused or rejected
        // aggregate page leaves the append itself unknown and retryable.
        settleAppend(askedNobody || activeCycleAggregateFailed, cycleWasAppend);
        pending = 'idle';
        rebuild();
        publish();
    }

    const scheduler = createCoalescedScheduler({
        drain: runCycle,
        ...(deps.onUnexpectedError ? { onError: deps.onUnexpectedError } : {}),
    });

    function dispose(): void {
        if (disposed) return;
        disposed = true;
        if (refreshDeadlineWake !== null) {
            clearTimeout(refreshDeadlineWake);
            refreshDeadlineWake = null;
        }
        retirement?.dispose();
        retirement = null;
        scheduler.dispose();
        coordinator.dispose();
        listeners.clear();
    }

    retirement = deps.lifetime?.onRetire(dispose) ?? null;
    publish();

    return Object.freeze({
        getSnapshot: readSnapshot,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        refresh(trigger) {
            if (!isCurrent()) return Promise.resolve();
            pagingResetPending = true;
            // Manual Refresh is the strongest intent in a coalesced cycle, so it
            // never loses to a view trigger that arrived first.
            if (trigger === 'manual' || pendingTrigger !== 'manual') pendingTrigger = trigger;
            return scheduler.flush();
        },
        loadMore() {
            if (!isCurrent()) return Promise.resolve();
            // Nothing to append to. A mount with no window has not read a
            // connection yet, and the first read is `refresh`'s to make.
            if (window === null) return Promise.resolve();
            // One append at a time, and the published arm says so: the two read
            // the same flag, so a row can never offer a press this refuses.
            if (appending) return Promise.resolve();
            if (appendFailed) {
                // Retry the depth already asked for. Deepening here would step
                // past a window this mount never received.
                appendFailed = false;
            } else {
                if (window.coverage === 'complete') return Promise.resolve();
                // The published arm and this gate read the same fact, so a row
                // can never offer a press this refuses.
                if (!anyLaneHoldsFrontier()) return Promise.resolve();
                if (windowsRequested >= MAX_TRIAGE_MOUNTED_WINDOWS_V1) return Promise.resolve();
                windowsRequested += 1;
            }
            appending = true;
            // The reader pressed a row, so this is explicit demand and the shared
            // minimum interval must not refuse it — the same reason **Refresh**
            // sends `manual`. The source's own retry deadline and the failure
            // backoff still apply, and still publish through `refreshBlocked`.
            pendingTrigger = 'manual';
            publish();
            return scheduler.flush();
        },
        setLens(next) {
            const acquisitionChanged = lens.order !== next.order
                || lens.smartPolicy.v !== next.smartPolicy.v
                || lens.smartPolicy.precedence[0] !== next.smartPolicy.precedence[0]
                || lens.smartPolicy.precedence[1] !== next.smartPolicy.precedence[1];
            lens = next;
            if (window !== null) rebuild();
            publish();
            if (acquisitionChanged) {
                pagingResetPending = true;
                generationReplacementPending = true;
                pendingTrigger = 'manual';
                scheduler.trigger();
            }
        },
        dispose,
    } satisfies TriageListWindowStoreV1);
}
