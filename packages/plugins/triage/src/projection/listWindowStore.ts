import { isPluginError, type PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { createCoalescedScheduler } from '@happier-dev/plugin-sdk/async';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';

import { foldConnectionAnswers } from '../corpus/fold/connectionAnswer.js';
import type { CorpusQualifiedObservationV1 } from '../corpus/fold/qualify.js';
import { sameTriageSourceIdentity } from '../corpus/identity/components.js';
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
    /**
     * Whether another read can succeed, as the host classified the failure. A
     * failure nobody classified is worth one more try; absent means that.
     */
    retryable?: boolean;
    /** The host's code and diagnostics, for a support reader, never the sentence. */
    detail?: string;
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
     * How many passes this mount has read: it moves once per pass the coordinator admitted, whether or not the
     * window changed, and never for a demand the pacing refused. A reader that follows reads (the list's
     * linked-Session join) keys on it rather than on the window, which stays the same object when a pass read
     * nothing new.
     */
    passes: number;
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
     * rows again, deduped away against the same retained page. Nothing new was
     * ever reachable that way. The reader is told the
     * list is incomplete instead, and **Refresh** is the control that can
     * actually change it.
     */
    | Readonly<{ kind: 'unresumable' }>;

export type TriageListWindowStoreV1 = Readonly<{
    getSnapshot(): TriageListWindowSnapshotV1;
    /** Project the retained acquisition through another lens without mutating it. */
    project(lens: TriageListLensV1): TriageListWindowV1 | undefined;
    subscribe(listener: () => void): () => void;
    /** The only way a consumer causes provider work. */
    refresh(trigger: TriageRefreshTriggerV1): Promise<void>;
    /**
     * Rebuild immediately from the retained page, then reacquire one neutral
     * first page for the new lens generation. Every lens change invalidates the
     * preceding per-lane frontiers; keeping them would let Load More resume the
     * new lens at an old lens's depth.
     *
     * It deliberately does **not** mark the retained page stale while that
     * replacement is pending. The provider read remains neutral, so the rows
     * already held are exactly as fresh as the cycle that fetched them.
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
    /**
     * The mounted read transport changed authority. Retain the last-known-good
     * rows, but synchronously invalidate every opaque provider frontier and
     * reacquire page one through the replacement reader.
     */
    replaceReadTransport(): void;
    dispose(): void;
}>;

export type TriageListWindowReaderV1 = (
    input: TriageListEntriesInputV1,
    options?: PluginCancellationOptions,
) => Promise<TriageListEntriesResultV1>;

type LaneState = {
    lane: TriageListLaneV1;
    /** Last-known-good: retained verbatim when the next pass for this lane fails. */
    observations: readonly CorpusQualifiedObservationV1[];
    /** Pages of the current resumable walk, excluding prior-walk continuity rows. */
    walkObservations?: readonly CorpusQualifiedObservationV1[];
    error: TriageListWindowErrorV1 | null;
    completedAtMs: number | null;
};

type LaneContinuation = NonNullable<TriageListEntriesInputV1['resume']>[number];

function sameConfiguredSourceAcquisitionSet(
    left: TriageListEntriesResultV1['configuredSources'],
    right: TriageListEntriesResultV1['configuredSources'],
): boolean {
    if (left.length !== right.length) return false;
    const rightBySourceInstanceId = new Map(right.map((summary) => [summary.sourceInstanceId, summary]));
    return left.every((summary) => {
        const candidate = rightBySourceInstanceId.get(summary.sourceInstanceId);
        if (candidate === undefined || !sameTriageSourceIdentity(summary.source, candidate.source)) return false;
        // The canonical Action always supplies the Collection revision. The
        // optional fallback keeps older in-process fixtures compatible without
        // minting a second configuration identity.
        return summary.configurationRevision === undefined
            || candidate.configurationRevision === undefined
            || summary.configurationRevision === candidate.configurationRevision;
    });
}

function sameMemberSet<T>(
    left: readonly T[],
    right: readonly T[],
    same: (leftMember: T, rightMember: T) => boolean,
): boolean {
    return left.length === right.length
        && left.every((member) => right.some((candidate) => same(member, candidate)));
}

function sameFilterSelection(
    left: TriageListLensV1['filters'],
    right: TriageListLensV1['filters'],
): boolean {
    // Facets are sets: press order changes no query and therefore must not mint
    // a new paging generation. Duplicate values are rejected by the reducer
    // and saved-view owner before a lens reaches this store.
    return sameMemberSet(left.sources, right.sources, (a, b) => (
        sameTriageSourceIdentity(a.source, b.source)
    ))
        && sameMemberSet(left.types, right.types, (a, b) => (
            a.kindId === b.kindId && sameTriageSourceIdentity(a.source, b.source)
        ))
        && sameMemberSet(left.scopes, right.scopes, (a, b) => (
            a.collisionScope === b.collisionScope
            && sameTriageSourceIdentity(a.source, b.source)
        ))
        && sameMemberSet(left.states, right.states, (a, b) => a === b)
        && sameMemberSet(left.attention, right.attention, (a, b) => a === b);
}

function sameAcquisitionLens(left: TriageListLensV1, right: TriageListLensV1): boolean {
    return left.order === right.order
        && left.smartPolicy.v === right.smartPolicy.v
        && left.smartPolicy.precedence[0] === right.smartPolicy.precedence[0]
        && left.smartPolicy.precedence[1] === right.smartPolicy.precedence[1]
        && left.query === right.query
        && left.limit === right.limit
        && sameFilterSelection(left.filters, right.filters);
}

function errorFrom(cause: unknown): TriageListWindowErrorV1 {
    if (isPluginError(cause)) {
        return {
            code: 'plugin_action_failed',
            message: cause.message,
            // The host's own verdict: `unsupported_method` or `denied` will
            // fail the same way however often the reader presses Refresh.
            retryable: cause.retryable,
            detail: [cause.code, ...(cause.diagnostics ?? []).map((diagnostic) => diagnostic.code)].join(' · '),
        };
    }
    if (cause instanceof Error) {
        return { code: 'plugin_action_failed', message: cause.message, retryable: true, detail: cause.message };
    }
    return { code: 'plugin_action_failed', message: 'The list could not be read.', retryable: true };
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

export function createTriageListWindowStore(deps: Readonly<{
    readEntries: TriageListWindowReaderV1;
    nowMs: () => number;
    lens?: TriageListLensV1;
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
    /** A refresh/lens-generation change resets depth at the next cycle boundary. */
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
    let passes = 0;
    let snapshot: TriageListWindowSnapshotV1 = Object.freeze({
        freshness: 'unknown',
        pending: 'idle',
        passes,
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
        return !disposed;
    }

    function freshness(): TriageListWindowSnapshotV1['freshness'] {
        if (window === null) return 'unknown';
        if (error !== null) return 'stale';
        // Every configured connection, not only the ones the final Action batch
        // walked. Each lane keeps the completion time measured on this store's
        // clock at its own batch boundary: stamping the whole cycle after a slow
        // tail batch makes an earlier lane look newly read even when it has
        // already aged past the interval. A connection with no admitted
        // contribution or one this bounded window has not reached has no lane,
        // and therefore cannot make a freshness claim either. This is the same
        // intended-versus-walked distinction `triageListCoverageLanes` owns for
        // coverage, applied to currentness.
        const nowMs = deps.nowMs();
        for (const summary of configuredSources) {
            const lane = lanes.get(summary.sourceInstanceId);
            if (
                lane === undefined
                || lane.error !== null
                || lane.completedAtMs === null
                || nowMs - lane.completedAtMs >= TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS
            ) return 'stale';
        }
        return 'fresh';
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
     * told about. Several refusals therefore report the EARLIEST deadline: that
     * is the moment this aggregate refusal ends, because the loop below already
     * stops refusing as soon as any one connection is admitted again. Reporting
     * the furthest one told the reader to come back long after the press would
     * have worked, and a control that waits for the moment it published waits
     * through the whole difference.
     *
     * Within ONE connection the opposite rule still holds and belongs where it
     * is: `evaluateRefreshEligibility` reports the latest of that connection's
     * own blockers, because every one of them has to elapse before it is
     * eligible.
     */
    function refreshBlock(): TriageRefreshPacingBlockV1 | null {
        let earliest: TriageRefreshPacingBlockV1 | null = null;
        for (const summary of configuredSources) {
            if (!summary.available) continue;
            const blocked = coordinator.pacingBlock({
                sourceInstanceId: summary.sourceInstanceId,
                trigger: 'manual',
            });
            if (blocked === null) return null;
            if (earliest === null || blocked.nextEligibleAtMs < earliest.nextEligibleAtMs) earliest = blocked;
        }
        return earliest;
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
        // These are the same replacement facts the imperative admission reads.
        // Publishing `available` while that path refuses the press is a split
        // answer from one owner, and an old frontier must not remain visible as
        // actionable while its replacement is pending.
        if (pagingResetPending || generationReplacementPending) return null;
        if (appending) return Object.freeze({ kind: 'loading' });
        if (appendFailed) return Object.freeze({ kind: 'failed' });
        if (window.coverage === 'complete') return Object.freeze({ kind: 'exhausted' });
        // Incomplete is not the same as resumable. A deeper window re-reads this
        // mount's depth and asks each lane to continue from where it stopped, so
        // with no lane holding a frontier the press would re-read page one and
        // deliver rows the merge already holds.
        if (!anyLaneHoldsFrontier()) return Object.freeze({ kind: 'unresumable' });
        return Object.freeze({ kind: 'available' });
    }

    /** Whether any lane stopped holding a page a deeper window could continue from. */
    function anyLaneHoldsFrontier(): boolean {
        const availableSourceCount = configuredSources.filter((summary) => summary.available).length;
        return continuations.size > 0
            || availableSourceCount > windowsRequested * MAX_TRIAGE_LIST_WINDOW_ROWS_V1;
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
        const appendable = loadMore();
        const next: TriageListWindowSnapshotV1 = Object.freeze({
            ...(window === null ? {} : { window }),
            freshness: freshness(),
            pending,
            passes,
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
        // Nothing a subscriber can read changed: notifying would only make every consumer recompute.
        if (sameTriageListWindowSnapshot(snapshot, next)) return;
        snapshot = next;
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

    function projectRetained(projectionLens: TriageListLensV1): TriageListWindowV1 {
        const observations: CorpusQualifiedObservationV1[] = [];
        const walked: TriageListLaneV1[] = [];
        for (const lane of lanes.values()) {
            observations.push(...lane.observations);
            walked.push(lane.lane);
        }
        return foldTriageListWindow({
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
            lens: projectionLens,
            assembledAtMs: deps.nowMs(),
        });
    }

    function rebuild(): void {
        const next = projectRetained({ ...lens, limit: foldLimit() });
        // A cycle the pacing refused, or a lens that projects the same rows, assembles a window that differs
        // only in when it was assembled. Every subscriber re-plans the whole list (and the list's Session join
        // and the open detail key on it), so the window that says the same thing is kept as it is.
        window = window !== null && sameTriageListWindowContent(window, next) ? window : next;
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
     * silent. The scan-pass owner leaves the lane unexhausted whenever another
     * native page could not fit, so rebuilding from that lane preserves
     * `coverage: 'partial'` without a second correction owner here:
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
        resume: TriageListEntriesInputV1['resume'] | undefined,
        limit: number,
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
            limit,
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
        const seenCursors = new Set<string>();
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
                if (seenCursors.has(result.configuredSourcesNextCursor)) {
                    throw new Error('Configured-source enumeration returned a repeated continuation cursor.');
                }
                seenCursors.add(result.configuredSourcesNextCursor);
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
    ): Readonly<{ acquisitionChanged: boolean; availabilityChanged: boolean }> {
        const previousConfiguredSources = configuredSources;
        const acquisitionChanged = !sameConfiguredSourceAcquisitionSet(
            configuredSources,
            nextConfiguredSources,
        );
        const previousBySourceInstanceId = new Map(
            previousConfiguredSources.map((summary) => [summary.sourceInstanceId, summary]),
        );
        configuredSources = nextConfiguredSources;
        configuredSourcesStatus = nextConfiguredSourcesStatus;
        const known = new Set(nextConfiguredSources.map((summary) => summary.sourceInstanceId));
        let availabilityChanged = false;
        for (const sourceInstanceId of [...lanes.keys()]) {
            if (known.has(sourceInstanceId)) continue;
            // The row is gone or retired: drop its lane and abort any pass it
            // still owns. A retired instance's late result must not reach the
            // window it no longer belongs in.
            lanes.delete(sourceInstanceId);
            continuations.delete(sourceInstanceId);
            coordinator.retire(sourceInstanceId);
        }
        for (const summary of nextConfiguredSources) {
            const previous = previousBySourceInstanceId.get(summary.sourceInstanceId);
            if (previous === undefined) continue;
            const revisionChanged = previous.configurationRevision !== undefined
                && summary.configurationRevision !== undefined
                && previous.configurationRevision !== summary.configurationRevision;
            const sourceChanged = !sameTriageSourceIdentity(previous.source, summary.source);
            if (revisionChanged || sourceChanged) {
                // Same stable instance id, different canonical configured-row
                // identity. Rows, frontier, pacing, retry and coverage all
                // belonged to the old configuration and cannot survive it.
                lanes.delete(summary.sourceInstanceId);
                continuations.delete(summary.sourceInstanceId);
                coordinator.retire(summary.sourceInstanceId);
                continue;
            }
            if (previous.available === summary.available) continue;
            availabilityChanged = true;
            // Contribution loss/re-admission is not provider absence. Keep the
            // last-known-good rows, but clear the active frontier and every
            // pacing/retry fact before another immutable contribution may run.
            continuations.delete(summary.sourceInstanceId);
            coordinator.retire(summary.sourceInstanceId);
            const retained = lanes.get(summary.sourceInstanceId);
            if (retained !== undefined) {
                lanes.set(summary.sourceInstanceId, {
                    ...retained,
                    lane: Object.freeze({
                        sourceInstanceId: summary.sourceInstanceId,
                        source: summary.source,
                        health: Object.freeze({ kind: 'unavailable' as const }),
                        exhausted: false,
                    }),
                    error: UNREADABLE_IN_THIS_PASS_V1,
                });
            }
        }
        return Object.freeze({ acquisitionChanged, availabilityChanged });
    }

    /** Reconcile one selected Action batch without treating it as the whole configured set. */
    function syncConfiguredSourceBatch(
        requestedSourceInstanceIds: readonly string[],
        nextBatch: TriageListEntriesResultV1['configuredSources'],
    ): Readonly<{ acquisitionChanged: boolean; availabilityChanged: boolean }> {
        const requested = new Set(requestedSourceInstanceIds);
        const nextBySourceInstanceId = new Map(nextBatch.map((summary) => [summary.sourceInstanceId, summary]));
        const merged = configuredSources.flatMap((summary) => {
            if (!requested.has(summary.sourceInstanceId)) return [summary];
            const next = nextBySourceInstanceId.get(summary.sourceInstanceId);
            return next === undefined ? [] : [next];
        });
        for (const summary of nextBatch) {
            if (merged.some((candidate) => candidate.sourceInstanceId === summary.sourceInstanceId)) continue;
            merged.push(summary);
        }
        return syncConfiguredSources(Object.freeze(merged), configuredSourcesStatus);
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
        const acquisitionLens = lens;
        const admitted = new Map<string, CorpusQualifiedObservationV1[]>();
        const settled = new Map<string, Readonly<{
            lane: TriageListLaneV1;
            completedAtMs: number;
            observations: readonly CorpusQualifiedObservationV1[];
        }>>();
        const outcomes = new Map<string, TriageRefreshPassOutcomeV1>();
        let remainingRowBudget = MAX_TRIAGE_LIST_WINDOW_ROWS_V1;
        for (const sourceInstanceId of input.sourceInstanceIds) admitted.set(sourceInstanceId, []);
        for (let offset = 0; offset < input.sourceInstanceIds.length;) {
            if (!isCurrent() || input.signal.aborted) {
                for (const sourceInstanceId of input.sourceInstanceIds) {
                    if (!outcomes.has(sourceInstanceId)) outcomes.set(sourceInstanceId, { kind: 'interrupted' });
                }
                return input.sourceInstanceIds.map((sourceInstanceId) => ({
                    sourceInstanceId,
                    outcome: outcomes.get(sourceInstanceId) ?? { kind: 'interrupted' },
                }));
            }
            if (remainingRowBudget === 0) break;
            const sourceInstanceIds = input.sourceInstanceIds.slice(
                offset,
                offset + Math.min(MAX_TRIAGE_LIST_SOURCE_BATCH_V1, remainingRowBudget),
            );
            offset += sourceInstanceIds.length;
            // Every selected Action batch contributes to ONE transport window,
            // and every named lane needs at least one row slot. While another
            // selected batch remains, spend exactly that first-round share; the
            // final batch may use capacity earlier short batches returned.
            // Giving every batch the full 56-row allowance acquired 88 rows from
            // 33 connections and folded 32 out of sight. Naming 32 lanes with a
            // 24-row remainder was worse: eight lanes were never asked but were
            // reported unavailable, so no continuation could reach them.
            const batchRowBudget = offset < input.sourceInstanceIds.length
                ? sourceInstanceIds.length
                : remainingRowBudget;
            const resume = activeCycleIsAppend
                ? sourceInstanceIds.flatMap((sourceInstanceId) => {
                    const continuation = continuations.get(sourceInstanceId);
                    return continuation === undefined ? [] : [continuation];
                })
                : undefined;

            let result: TriageListEntriesResultV1;
            try {
                result = await deps.readEntries(
                    scanInputFor(sourceInstanceIds, resume, batchRowBudget),
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

            // The Action result belongs to the complete lens identity that
            // submitted its cursor. A lens change can occur while the provider
            // page is awaiting; adopting that page would briefly publish the old
            // frontier under the new lens before the queued replacement runs.
            if (!sameAcquisitionLens(acquisitionLens, lens)) {
                for (const sourceInstanceId of input.sourceInstanceIds) {
                    if (!outcomes.has(sourceInstanceId)) outcomes.set(sourceInstanceId, { kind: 'interrupted' });
                }
                return input.sourceInstanceIds.map((sourceInstanceId) => ({
                    sourceInstanceId,
                    outcome: outcomes.get(sourceInstanceId) ?? { kind: 'interrupted' },
                }));
            }

            const configuredSourceChange = syncConfiguredSourceBatch(
                sourceInstanceIds,
                result.configuredSources,
            );
            if (configuredSourceChange.acquisitionChanged) {
                // The result itself already re-read the Collection after its
                // provider work. Keep none of the old revision, clear its whole
                // mounted cut, and let this same named demand reacquire the
                // current configuration through the coalesced follow-up.
                resetPagingGeneration({ replacesGeneration: true });
                pendingTrigger = 'manual';
                scheduler.trigger();
            }
            if (configuredSourceChange.acquisitionChanged
                || configuredSourceChange.availabilityChanged
                || input.signal.aborted) {
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
            remainingRowBudget = Math.max(0, remainingRowBudget - result.window.rows.length);
            // Client/store time, recorded at the exact batch boundary. The
            // Action may execute on another machine, so its assembledAtMs is not
            // comparable with this mounted store's freshness clock.
            const batchCompletedAtMs = deps.nowMs();
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
                const walkObservations = retainObservations(
                    resume?.some((entry) => entry.sourceInstanceId === sourceInstanceId)
                        ? lanes.get(sourceInstanceId)?.walkObservations ?? []
                        : [],
                    laneObservations,
                    true,
                );
                if (lane === undefined) {
                    outcomes.set(sourceInstanceId, { kind: 'interrupted' });
                    continue;
                }
                if (lane.health.kind === 'failed') {
                    recordLaneFailure(sourceInstanceId, lane, {
                        code: lane.health.failure.code,
                        message: lane.health.failure.detail ?? lane.health.failure.class,
                    }, walkObservations);
                    outcomes.set(sourceInstanceId, { kind: 'failed', failure: lane.health.failure });
                    continue;
                }
                if (lane.health.kind === 'unavailable') {
                    recordLaneFailure(sourceInstanceId, lane, UNREADABLE_IN_THIS_PASS_V1, walkObservations);
                    outcomes.set(sourceInstanceId, { kind: 'interrupted' });
                    continue;
                }
                settled.set(sourceInstanceId, Object.freeze({
                    lane, completedAtMs: batchCompletedAtMs, observations: walkObservations,
                }));
                outcomes.set(sourceInstanceId, { kind: 'completed' });
            }
        }

        for (const sourceInstanceId of input.sourceInstanceIds) {
            const completed = settled.get(sourceInstanceId);
            if (completed === undefined) continue;
            const { lane } = completed;
            const walkObservations = completed.observations;
            lanes.set(sourceInstanceId, {
                lane,
                // A terminal append publishes all pages of THIS walk, not the
                // old membership retained while the refresh was incomplete.
                // Replacing membership makes no entity-absence or durable-state claim.
                observations: activeCycleReplacesGeneration || lane.exhausted
                    ? walkObservations
                    : retainObservations(lanes.get(sourceInstanceId)?.observations ?? [], walkObservations),
                ...(continuations.has(sourceInstanceId) ? { walkObservations } : {}),
                error: null,
                completedAtMs: completed.completedAtMs,
            });
        }
        return input.sourceInstanceIds.map((sourceInstanceId) => ({
            sourceInstanceId,
            outcome: outcomes.get(sourceInstanceId) ?? { kind: 'interrupted' },
        }));
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
     * Only a clean completed walk replaces scan membership. A failed walk
     * cannot do so; its continuity overlay uses the same retained capacity.
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
        sameWalk = false,
    ): readonly CorpusQualifiedObservationV1[] {
        if (admitted.length === 0) return retained;
        const merged = new Map<string, CorpusQualifiedObservationV1>();
        for (const observation of retained) merged.set(triageEntryRowKey(observation.entryRef), observation);
        for (const observation of admitted) {
            const key = triageEntryRowKey(observation.entryRef);
            const earlier = merged.get(key);
            // Re-inserted at the back: insertion order is what eviction reads,
            // and this pass's answers must be the last thing it would drop.
            merged.delete(key);
            merged.set(key, earlier === undefined || !sameWalk ? observation : layerWalkAnswer(earlier, observation));
        }
        const values = [...merged.values()];
        const capacity = retainedObservationCapacity();
        return Object.freeze(
            values.length <= capacity ? values : values.slice(values.length - capacity),
        );
    }

    /**
     * The two answers one connection gave for one entry, layered.
     *
     * A source is designed to meet the same entry more than once inside ONE
     * walk and to report only the fact each native lane established — GitHub
     * asks five involvement queries and pre-dedupes none of them
     * (`scm-github/src/triage/scan/frontier.ts`). Inside one invocation the
     * canonical connection-answer fold already unions those encounters; across
     * the transport windows this mount appends, the union has to happen here or
     * it does not happen at all, and a later `participating` page silently
     * removes a pull request from **Needs your attention** while the review is
     * still blocked on the reader.
     *
     * Only pages resumed within the SAME WALK accumulate. A fresh walk starts
     * at page one, and its answers replace old facts in the continuity overlay;
     * otherwise a withdrawn review request would be unioned forever. An append
     * may also visit an unvisited source, so append mode alone is not evidence
     * that two answers belong to the same walk.
     *
     * The union itself is not written here: `foldConnectionAnswers` is the one
     * owner of what merging two answers of one connection means, and it is
     * asked the same question the assembled pass asks it.
     */
    function layerWalkAnswer(
        earlier: CorpusQualifiedObservationV1,
        later: CorpusQualifiedObservationV1,
    ): CorpusQualifiedObservationV1 {
        const folded = foldConnectionAnswers([earlier, later]);
        const winner = folded.length === 1 ? folded[0] : undefined;
        // Two answers the fold left apart — a different connection, or an
        // outcome that carries no viewer facts to union — keep the newer one.
        return winner === undefined ? later : { ...winner, entryRef: later.entryRef };
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
            const configuredSourceChange = syncConfiguredSources(
                enumeration.configuredSources,
                enumeration.configuredSourcesStatus,
            );
            if (configuredSourceChange.acquisitionChanged && window !== null) {
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

        const availableSourceInstanceIds = configuredSources
            .filter((summary) => summary.available)
            .map((summary) => summary.sourceInstanceId);
        const firstUnvisitedSourceIndex = (windowsRequested - 1) * MAX_TRIAGE_LIST_WINDOW_ROWS_V1;
        const appendSourceInstanceIds = cycleWasAppend
            ? [...new Set([
                // A page with more configured connections than rows resumes the
                // next configured slice before deepening an earlier lane. The
                // slice is derived from the existing mounted depth; retained
                // last-known-good lanes may belong to a preceding refresh
                // generation, so their mere presence cannot prove this page
                // reacquired them. No second census or generation is stored.
                ...availableSourceInstanceIds.slice(
                    firstUnvisitedSourceIndex,
                    firstUnvisitedSourceIndex + MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
                ),
                ...availableSourceInstanceIds.filter((sourceInstanceId) => continuations.has(sourceInstanceId)),
            ])]
            : availableSourceInstanceIds;
        const request = coordinator.request({
            // One row is the smallest fair share for one selected lane. Do not
            // tell the coordinator a connection started when the 56-row window
            // cannot ask it at all; the untouched suffix remains derivable from
            // the mounted lane map and is taken first by Load More.
            sourceInstanceIds: appendSourceInstanceIds.slice(0, MAX_TRIAGE_LIST_WINDOW_ROWS_V1),
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
            passes += 1;
            rebuild();
            publish();
        }
        if (!isCurrent()) return;
        const askedNobody = request.startedSourceInstanceIds.length === 0;
        if (
            activeCycleReplacesGeneration
            && request.blocked.length === 0
            && !activeCycleAggregateFailed
            // Only this bounded cut was requested. The untouched configured
            // suffix must remain reachable through Load More after it settles.
            && request.startedSourceInstanceIds
                .every((sourceInstanceId) => lanes.get(sourceInstanceId)?.error === null)
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
        scheduler.dispose();
        coordinator.dispose();
        listeners.clear();
    }

    publish();

    return Object.freeze({
        getSnapshot: readSnapshot,
        project(nextLens) {
            return window === null ? undefined : projectRetained(nextLens);
        },
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
            // A lens replacement has invalidated every continuation from the
            // previous generation.  The replacement refresh may be waiting on
            // the coordinator's pacing window; do not let Load More race it
            // and send an old cursor under the new lens.
            if (pagingResetPending || generationReplacementPending) return Promise.resolve();
            if (appendFailed) {
                // Retry the depth already asked for. Deepening here would step
                // past a window this mount never received.
                appendFailed = false;
            } else {
                if (window.coverage === 'complete') return Promise.resolve();
                // The published arm and this gate read the same fact, so a row
                // can never offer a press this refuses.
                if (!anyLaneHoldsFrontier()) return Promise.resolve();
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
        replaceReadTransport() {
            if (!isCurrent()) return;
            resetPagingGeneration({ replacesGeneration: true });
            // A cycle already in flight may still settle its append bookkeeping
            // after this synchronous reset. Keep one reset intent queued so the
            // replacement cycle clears that stale settlement before page one.
            pagingResetPending = true;
            pendingTrigger = 'manual';
            publish();
            scheduler.trigger();
        },
        setLens(next) {
            // Re-applying the lens this mount already projects (every shell mount does) changes nothing.
            if (pluginJsonValuesEqual(lens, next)) return;
            // A continuation belongs to the complete mounted lens generation
            // that produced it. Query/facet changes are projected locally, but
            // retaining their predecessor frontier would let Load More resume
            // the new lens at the old lens's depth. Reacquire one neutral first
            // page and mint a fresh frontier set instead. This remains the same
            // store, coordinator and coalesced scheduler; no search-owned reader
            // or cursor state is introduced.
            const acquisitionChanged = !sameAcquisitionLens(lens, next);
            lens = next;
            if (acquisitionChanged) {
                // Invalidate admission before publishing the newly projected
                // lens. Subscribers run synchronously inside `publish`; doing
                // this afterwards briefly offered the predecessor frontier and
                // the imperative path would have accepted that press too.
                pagingResetPending = true;
                generationReplacementPending = true;
                pendingTrigger = 'manual';
            }
            if (window !== null) rebuild();
            publish();
            if (acquisitionChanged) {
                scheduler.trigger();
            }
        },
        dispose,
    } satisfies TriageListWindowStoreV1);
}

/** Two windows that say the same thing: everything but the moment each was assembled. */
function sameTriageListWindowContent(left: TriageListWindowV1, right: TriageListWindowV1): boolean {
    return pluginJsonValuesEqual({ ...left, assembledAtMs: 0 }, { ...right, assembledAtMs: 0 });
}

/**
 * Two snapshots a subscriber cannot tell apart: the same window object and equal plain members (the configured
 * sources are re-enumerated each cycle into a new array). An aggregate error is compared by identity, because it
 * is a retained value, not a projection.
 */
function sameTriageListWindowSnapshot(left: TriageListWindowSnapshotV1, right: TriageListWindowSnapshotV1): boolean {
    const { window: leftWindow, error: leftError, ...leftRest } = left;
    const { window: rightWindow, error: rightError, ...rightRest } = right;
    return leftWindow === rightWindow
        && leftError === rightError
        && pluginJsonValuesEqual(leftRest, rightRest);
}
