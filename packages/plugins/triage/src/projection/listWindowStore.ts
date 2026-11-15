import { selectTriageListSourcesV1 } from './listSort.js';
import { isPluginError, readPluginErrorRequestIdV1, type PluginCancellationOptions } from '@happier-dev/plugin-sdk';
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
    type TriageRefreshPacingBlockV1,
    type TriageRefreshTriggerV1,
} from '../refresh/refreshEligibility.js';

import {
    MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
    type TriageListInvocationErrorV1,
    type TriageListEntriesInputV1,
    type TriageListEntriesResultV1,
} from '../actions/listEntriesProtocol.js';
import {
    TRIAGE_LIST_DEFAULT_LENS_V1,
    foldTriageListWindow,
    foldTriagePostMutationObservation,
    createTriageListFoldBaselineV1,
    triageEntryRowKey,
    MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
    triageListCoverageLanes,
    type TriageListLaneV1,
    type TriageListLensV1,
    type TriageListWindowV1,
    type TriageListRowV1,
} from './listWindow.js';
import { retainTriageObservation, retainTriageProjectionArray, retainTriageProjectionValue } from './listWindowReconciliation.js';
import { projectTriageEntrySearchText } from './entrySearch.js';
import type { InternalTaskListProjection } from '../internalTasks/listProjection.js';

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
    /** Structured host reasons; presentation never parses the diagnostic disclosure. */
    diagnostics?: readonly string[];
    requestId?: string;
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
}> & Partial<TriageListInvocationErrorV1>;

export type TriageListWindowSnapshotV1 = Readonly<{
    taskProjection?: InternalTaskListProjection;
    /** The last admitted window. Retained across a failed refresh. */
    window?: TriageListWindowV1;
    freshness: 'unknown' | 'fresh' | 'stale';
    /**
     * Oldest last-successful available-lane read, on this store's clock — the
     * completion fact shown to readers. Absent until every available
     * lane has completed a read (and when none are available). Unavailable
     * contributions keep their own coverage/health without preventing a read
     * from settling. Failed refreshes retain this time; re-folding or a
     * paced-away demand cannot advance it.
     */
    completedAtMs?: number;
    pending: 'idle' | 'initial' | 'refresh';
    /** The host is still establishing its Machine binding; original diagnostics remain available. */
    /**
     * How many passes this mount has read: it moves once per pass the coordinator admitted, whether or not the
     * window changed, and never for a demand the pacing refused. A reader that follows reads (the list's
     * linked-Session join) keys on it rather than on the window, which stays the same object when a pass read
     * nothing new.
     */
    passes: number;
    /**
     * The aggregate list read itself failed **and produced no window at all**,
     * and no retry is currently reading that first window.
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
     * source retry deadline is still running.
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

export type TriageListWindowChangeV1 = Readonly<{
    changedRows: readonly TriageListRowV1[];
    metadataChanged: boolean;
    /** Membership/order or non-row window facts changed. */
    structureChanged: boolean;
}>;

export type TriageListWindowStoreV1 = Readonly<{
    getSnapshot(): TriageListWindowSnapshotV1;
    /** Project the retained acquisition through another lens without mutating it. */
    project(lens: TriageListLensV1): TriageListWindowV1 | undefined;
    subscribe(listener: (change: TriageListWindowChangeV1) => void): () => void;
    /** Read retained entry truth, including entries outside the current lens. */
    getRow(key: string): TriageListRowV1 | null;
    subscribeRow(key: string, listener: () => void): () => void;
    /** Fold an exact read; source-change observations can reconcile membership, while exact-only opens do not acquire it. */
    publishObservation(observation: CorpusQualifiedObservationV1, keepViewerFacts?: boolean,
        options?: Readonly<{ reconcileMembership: true }>): TriageListRowV1 | null;
    /** The only way a consumer causes provider work. */
    refresh(trigger: TriageRefreshTriggerV1): Promise<void>;
    /** Re-read known changed lanes through the same scheduler, without enumerating unrelated sources. */
    refreshSources(sourceInstanceIds: readonly string[]): Promise<void>;
    /**
     * Rebuild from retained rows. Ranking and task-scope changes replace
     * acquisition and its frontiers; text and facets remain local projections.
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
     * row — and still honors the source's own retry deadline.
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
    taskProjection?: InternalTaskListProjection;
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
        if (candidate === undefined || !sameTriageSourceIdentity(summary.source, candidate.source)
            || summary.configurationRowId !== candidate.configurationRowId) return false;
        // The canonical Action always supplies the Collection revision. The
        // optional fallback keeps older in-process fixtures compatible without
        // minting a second configuration identity.
        return summary.configurationRevision === undefined
            || candidate.configurationRevision === undefined
            || summary.configurationRevision === candidate.configurationRevision;
    });
}

function sameAcquisitionLens(left: TriageListLensV1, right: TriageListLensV1, sources: TriageListEntriesResultV1['configuredSources']): boolean {
    return left.tasks?.completedSinceMs === right.tasks?.completedSinceMs
        && left.limit === right.limit
        && left.sort?.field === right.sort?.field
        && left.sort?.direction === right.sort?.direction
        && (left.sort === undefined && right.sort === undefined || pluginJsonValuesEqual(
            selectTriageListSourcesV1(sources, left.filters).map(source => source.sourceInstanceId),
            selectTriageListSourcesV1(sources, right.filters).map(source => source.sourceInstanceId),
        ));
}

function errorFrom(cause: unknown): TriageListWindowErrorV1 {
    if (isPluginError(cause)) {
        const requestId = readPluginErrorRequestIdV1(cause);
        return {
            code: cause.code,
            message: cause.message,
            // The host's own verdict: `unsupported_method` or `denied` will
            // fail the same way however often the reader presses Refresh.
            retryable: cause.retryable,
            ...(requestId === undefined ? {} : { requestId }),
            ...(cause.diagnostics?.length ? { diagnostics: cause.diagnostics.map(diagnostic => diagnostic.code) } : {}),
            detail: [cause.code, ...(cause.diagnostics ?? []).map((diagnostic) => diagnostic.code),
                ...(requestId ? [`Request ID: ${requestId}`] : [])].join(' · '),
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
export const UNREADABLE_IN_THIS_PASS_V1: TriageListWindowErrorV1 = Object.freeze({
    code: 'source_unavailable',
    message: 'The source could not be read in this pass.',
});

export function createTriageListWindowStore(deps: Readonly<{
    readEntries: TriageListWindowReaderV1;
    nowMs: () => number;
    lens?: TriageListLensV1;
    onUnexpectedError?: (error: unknown) => void;
    onRowProjected?: (entryRef: TriageListWindowV1['rows'][number]['entryRef']) => void;
}>): TriageListWindowStoreV1 {
    const listeners = new Set<(change: TriageListWindowChangeV1) => void>();
    const changedRowKeys = new Set<string>();
    const rowSubscriptions = new Map<string, { row: TriageListRowV1 | null; listeners: Set<() => void> }>();
    const lanes = new Map<string, LaneState>();
    const foldBaseline = createTriageListFoldBaselineV1();
    /** Provider frontiers retained only for this mounted store's lifetime. */
    const continuations = new Map<string, LaneContinuation>();
    let lens: TriageListLensV1 = deps.lens ?? TRIAGE_LIST_DEFAULT_LENS_V1;
    /** Entry order emitted by the aggregate for this mounted sorted prefix. */
    let orderedEntryKeys: readonly string[] | null = null;
    let configuredSources: TriageListEntriesResultV1['configuredSources'] = [];
    let configuredSourcesStatus: TriageListEntriesResultV1['configuredSourcesStatus'] = 'complete';
    let window: TriageListWindowV1 | null = null;
    let error: TriageListWindowErrorV1 | null = null;
    let pending: TriageListWindowSnapshotV1['pending'] = 'idle';
    let pendingTrigger: TriageRefreshTriggerV1 = 'view';
    let pendingSourceRefresh: Set<string> | undefined;
    /**
     * How many bounded windows this mount holds.
     *
     * It is one integer and lives exactly as long as this store. The matching
     * provider frontiers live in `continuations` for exactly the
     * same mounted lifetime. No page is checkpointed and a remade mount starts
     * at one window with no frontier, which is `INV-03` holding.
     */
    let windowsRequested = 1;
    /** Queued refresh intent resets depth when its cycle admits a read. */
    let pagingResetPending = false;
    /** Failed lanes keep their old membership until a replacement read succeeds. */
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

    function acquisitionSources(acquisitionLens = lens): TriageListEntriesResultV1['configuredSources'] {
        return acquisitionLens.sort === undefined ? configuredSources : selectTriageListSourcesV1(configuredSources, acquisitionLens.filters);
    }

    function completedAtMs(): number | undefined {
        let oldest: number | undefined;
        for (const summary of acquisitionSources()) {
            if (!summary.available) continue;
            const completed = lanes.get(summary.sourceInstanceId)?.completedAtMs;
            if (completed == null) return undefined;
            oldest = oldest === undefined ? completed : Math.min(oldest, completed);
        }
        return oldest;
    }

    function freshness(completed: number | undefined): TriageListWindowSnapshotV1['freshness'] {
        if (window === null) return 'unknown';
        if (error !== null || completed === undefined) return 'stale';
        for (const summary of acquisitionSources()) {
            if (!summary.available) continue;
            const lane = lanes.get(summary.sourceInstanceId);
            if (
                lane === undefined
                || lane.error !== null
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
            unreadable.push(Object.freeze({
                sourceInstanceId, message: state.error.message,
                code: state.error.code,
                ...(state.error.requestId === undefined ? {} : { requestId: state.error.requestId }),
                ...(state.error.retryable === undefined ? {} : { retryable: state.error.retryable }),
            }));
        }
        return retainTriageProjectionValue(snapshot.unreadableSources, Object.freeze(unreadable));
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
        if (lens.sort !== undefined) return coordinator.pacingBlock({
            sourceInstanceIds: acquisitionSources().filter(source => source.available).map(source => source.sourceInstanceId),
            requireAllSources: true, trigger: 'manual',
        });
        let earliest: TriageRefreshPacingBlockV1 | null = null;
        for (const summary of acquisitionSources()) {
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
        // A queued replacement cannot offer its predecessor's frontier. Its
        // healthy frontiers remain actionable even if another lane still
        // needs its old membership replaced.
        if (pagingResetPending) return null;
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
        const availableSourceCount = acquisitionSources().filter((summary) => summary.available).length;
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
        const blocked = retainTriageProjectionValue(snapshot.refreshBlocked, refreshBlock() ?? undefined);
        const appendable = retainTriageProjectionValue(snapshot.loadMore, loadMore() ?? undefined);
        const completed = completedAtMs();
        const taskState = [...lanes.values()].find(state => state.taskProjection !== undefined);
        const taskFailure = taskState?.lane.health.kind === 'failed' ? taskState.lane.health.failure
            : taskState?.error === null || taskState?.error === undefined ? undefined
                : { class: 'transient' as const, code: taskState.error.code };
        const taskProjection = retainTriageProjectionValue(snapshot.taskProjection, taskState?.taskProjection === undefined ? undefined
            : taskFailure === undefined ? taskState.taskProjection : { ...taskState.taskProjection, failure: taskFailure,
                entries: taskState.taskProjection.entries.map(entry => ({ ...entry, result: { kind: 'failed' as const, links: [],
                    lanes: entry.result.lanes?.map(lane => ({ ...lane, health: { kind: 'failed' as const, failure: taskFailure } })),
                } })) });
        const next: TriageListWindowSnapshotV1 = Object.freeze({
            ...(taskProjection === undefined ? {} : { taskProjection }),
            ...(window === null ? {} : { window }),
            freshness: freshness(completed),
            ...(completed === undefined ? {} : { completedAtMs: completed }),
            pending,
            passes,
            ...(appendable === undefined ? {} : { loadMore: appendable }),
            // The one gate on the store-wide slot, and the reason it is here
            // rather than at each writer: "the list could not be read" is only
            // true while there is no list. A writer that forgets this puts that
            // sentence beside rows the reader is looking at, which is the
            // failure this slot has produced three times. It still holds the
            // retained error internally, so freshness never claims a window is
            // current after a read that failed. An initial retry is loading,
            // not a settled failure: publish its verdict only after it settles.
            ...(error === null || window !== null || pending !== 'idle' ? {} : { error }),
            ...(unreadable.length === 0 ? {} : { unreadableSources: unreadable }),
            ...(blocked === undefined ? {} : { refreshBlocked: blocked }),
            configuredSources,
        });
        // Nothing a subscriber can read changed: notifying would only make every consumer recompute.
        const snapshotChanged = !sameTriageListWindowSnapshot(snapshot, next);
        if (snapshotChanged) {
            const previousWindow = snapshot.window;
            const nextWindow = next.window;
            const structureChanged = previousWindow === undefined || nextWindow === undefined
                ? previousWindow !== nextWindow
                : previousWindow.coverage !== nextWindow.coverage
                    || previousWindow.lanes !== nextWindow.lanes
                    || previousWindow.facetCensus !== nextWindow.facetCensus
                    || previousWindow.rows.length !== nextWindow.rows.length
                    || previousWindow.rows.some((row, index) => triageEntryRowKey(row.entryRef)
                        !== triageEntryRowKey(nextWindow.rows[index]!.entryRef));
            const metadataChanged = !sameTriageListWindowSnapshot(snapshot, { ...next, window: snapshot.window });
            snapshot = next;
            const changedRows = [...changedRowKeys].flatMap(key => {
                const row = foldBaseline.entries.get(key)?.row;
                return row === undefined ? [] : [row];
            });
            const change = { changedRows, structureChanged, metadataChanged };
            // Display producers adopt changed facts before keyed readers are notified.
            for (const listener of [...listeners]) listener(change);
        }
        changedRowKeys.clear();
        for (const [key, subscription] of rowSubscriptions) {
            const row = foldBaseline.entries.get(key)?.row ?? null;
            if (subscription.row === row) continue;
            subscription.row = row;
            for (const listener of [...subscription.listeners]) listener();
        }
    }

    /**
     * Freshness and pacing deadlines age on read without scheduling a wake.
     * Keep the same snapshot object until a published fact actually changes.
     */
    function readSnapshot(): TriageListWindowSnapshotV1 {
        const current = freshness(snapshot.completedAtMs);
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

    function projectRetained(projectionLens: TriageListLensV1, retainWindow = true): TriageListWindowV1 {
        const intendedSources = acquisitionSources(projectionLens);
        let observations: CorpusQualifiedObservationV1[] = [];
        const walked: TriageListLaneV1[] = [];
        for (const lane of lanes.values()) {
            observations.push(...lane.observations);
            walked.push(lane.lane);
        }
        if (projectionLens.sort !== undefined && orderedEntryKeys !== null) {
            const byEntry = new Map<string, CorpusQualifiedObservationV1[]>();
            for (const observation of observations) {
                const key = triageEntryRowKey(observation.entryRef);
                const values = byEntry.get(key) ?? [];
                values.push(observation);
                byEntry.set(key, values);
            }
            observations = orderedEntryKeys.flatMap(key => byEntry.get(key) ?? []);
        }
        return foldTriageListWindow({
            // A one-off reader shares admitted rows, but does not replace the mounted lens's window baseline.
            baseline: retainWindow ? foldBaseline : { ...foldBaseline },
            onRowProjected: entryRef => {
                if (retainWindow) changedRowKeys.add(triageEntryRowKey(entryRef));
                deps.onRowProjected?.(entryRef);
            },
            observations,
            // Every configured source is a lane of this window, including one no
            // pass could ask: this mount set out to cover it either way.
            lanes: triageListCoverageLanes({ intended: intendedSources, walked }),
            configuredSourcesStatus,
            activeSourceInstanceIds: intendedSources
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
        window = projectRetained({ ...lens, limit: foldLimit() });
    }

    /** Provider acquisition follows task scope, page geometry and source-owned sort. Text, facets,
     * order and Smart policy project retained rows locally, including appended pages. */
    function scanInputFor(
        sourceInstances: Extract<TriageListEntriesInputV1['sources'], { kind: 'selected' }>['sourceInstances'],
        /**
         * The frontier set this invocation resumes from, already paired with the
         * lanes it belongs to.
         *
         * It is the caller's set rather than one token this function fans out
             * over `sourceInstances`, because a continuation belongs to the walk
         * that produced it: handing the same token to every named connection is
         * exactly the confusion the per-lane map exists to make impossible.
         */
        resume: TriageListEntriesInputV1['resume'] | undefined,
        limit: number,
    ): TriageListEntriesInputV1 {
        return {
            v: 1,
            sources: { kind: 'selected', sourceInstances },
            /*
             * Where the preceding mounted window stopped, when this is Load
             * More.
             *
             * The mounted store retains it only until the next Load More,
             * Refresh, acquisition-scope change, or unmount. That is enough to
             * make Load More linear without minting durable cursor custody.
             */
            ...(resume === undefined ? {} : { resume }),
            limit,
            order: lens.order,
            ...(lens.sort === undefined ? {} : { sort: lens.sort }),
            smartPolicy: lens.smartPolicy,
            ...(lens.tasks === undefined ? {} : { tasks: lens.tasks }),
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
            ...(lens.tasks === undefined ? {} : { tasks: lens.tasks }),
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
        if (input.replacesGeneration) {
            generationReplacementPending = true;
            orderedEntryKeys = null;
        }
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
        configuredSources = retainTriageProjectionArray(previousConfiguredSources, nextConfiguredSources.map(summary =>
            retainTriageProjectionValue(previousBySourceInstanceId.get(summary.sourceInstanceId), summary)));
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
     * One independently settling read per configured source.
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
        const outcomes = new Map<string, TriageRefreshPassOutcomeV1>();
        const nextPass = passes + 1;
        // The first independently settled source publishes this pass together
        // with its rows. Neither admission nor the last source settling is a
        // separate relationship-read demand.
        function publishRead(): void {
            passes = nextPass;
            rebuild();
            publish();
        }
        // Explicit field order is merged by the aggregate before paging. Named
        // local orders retain independent source settlement and publication.
        const rowShare = Math.floor(MAX_TRIAGE_LIST_WINDOW_ROWS_V1 / input.sourceInstanceIds.length);
        const extraRows = MAX_TRIAGE_LIST_WINDOW_ROWS_V1 % input.sourceInstanceIds.length;
        const configuredBySourceInstanceId = new Map(configuredSources.map(source => [source.sourceInstanceId, source]));
        const batches = acquisitionLens.sort === undefined
            ? input.sourceInstanceIds.map(sourceInstanceId => [sourceInstanceId])
            : [input.sourceInstanceIds];
        await Promise.all(batches.map(async (sourceInstanceIds, index) => {
            if (!isCurrent() || input.signal.aborted) return;
            const resume = activeCycleIsAppend
                ? sourceInstanceIds.map(id => continuations.get(id)).filter((entry): entry is LaneContinuation => entry !== undefined)
                : undefined;
            // The Action already chose this lane's native geometry. Its whole
            // atomic page must fit the transport even when the fair share shrinks.
            const batchRowBudget = Math.max(
                acquisitionLens.sort === undefined
                    ? rowShare + (index < extraRows ? 1 : 0)
                    : MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
                ...(resume ?? []).map(entry => entry.pageLimit),
            );

            let result: TriageListEntriesResultV1;
            try {
                result = await deps.readEntries(
                    scanInputFor(sourceInstanceIds.map(id => {
                        const source = configuredBySourceInstanceId.get(id)!;
                        return { sourceInstanceId: id, configurationRowId: source.configurationRowId };
                    }), resume, batchRowBudget),
                    { signal: input.signal },
                );
            } catch (cause) {
                activeCycleAggregateFailed = true;
                for (const sourceInstanceId of sourceInstanceIds) {
                    if (!input.signal.aborted) recordLaneError(sourceInstanceId, errorFrom(cause));
                    outcomes.set(sourceInstanceId, { kind: 'interrupted' });
                }
                publishRead();
                return;
            }
            if (!isCurrent() || input.signal.aborted) {
                return;
            }

            // The Action result belongs to the acquisition lens that
            // submitted its cursor. Task scope or page geometry can change while the
            // provider page is awaiting; adopting that page would briefly publish the old
            // frontier under the new lens before the queued replacement runs.
            if (!sameAcquisitionLens(acquisitionLens, lens, configuredSources)) {
                return;
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
                return;
            }

            const nextContinuations = new Map(
                (result.window.continuations ?? []).map((entry) => [entry.sourceInstanceId, entry]),
            );
            // Client/store time, recorded at the exact batch boundary. The
            // Action may execute on another machine, so its assembledAtMs is not
            // comparable with this mounted store's freshness clock.
            const batchCompletedAtMs = deps.nowMs();
            if (acquisitionLens.sort !== undefined) {
                const emittedKeys = result.window.rows.map(row => triageEntryRowKey(row.entryRef));
                const retainsPreviousPrefix = activeCycleIsAppend || result.window.lanes.some(
                    lane => lane.health.kind === 'failed' || lane.health.kind === 'unavailable',
                );
                orderedEntryKeys = retainsPreviousPrefix
                    ? [...new Set([...(orderedEntryKeys ?? []), ...emittedKeys])]
                    : emittedKeys;
            }
            for (const sourceInstanceId of sourceInstanceIds) {
                continuations.delete(sourceInstanceId);
                const next = nextContinuations.get(sourceInstanceId);
                if (next !== undefined) continuations.set(sourceInstanceId, next);

                const lane = result.window.lanes.find(
                    (candidate) => candidate.sourceInstanceId === sourceInstanceId,
                );
                const laneObservations = laneObservationsFromWire(result, sourceInstanceId);
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
                    }, walkObservations, result.window.taskProjection);
                    outcomes.set(sourceInstanceId, { kind: 'failed', failure: lane.health.failure });
                    continue;
                }
                if (lane.health.kind === 'unavailable') {
                    recordLaneFailure(sourceInstanceId, lane, {
                        ...UNREADABLE_IN_THIS_PASS_V1,
                        ...lane.health.error,
                    }, walkObservations, result.window.taskProjection);
                    outcomes.set(sourceInstanceId, { kind: 'interrupted' });
                    continue;
                }
                const observations = activeCycleReplacesGeneration || lane.exhausted
                    ? reconcileAdmittedObservations(lanes.get(sourceInstanceId)?.observations ?? [], walkObservations)
                    : retainObservations(lanes.get(sourceInstanceId)?.observations ?? [], walkObservations);
                lanes.set(sourceInstanceId, {
                    lane,
                    // A completed walk replaces its membership; an unfinished
                    // walk retains the last known rows beside its new pages.
                    observations,
                    taskProjection: reconcileTaskProjection(sourceInstanceId, result.window.taskProjection, observations),
                    ...(continuations.has(sourceInstanceId) ? { walkObservations } : {}),
                    error: null,
                    completedAtMs: batchCompletedAtMs,
                });
                outcomes.set(sourceInstanceId, { kind: 'completed' });
            }
            publishRead();
        }));
        // A superseded lens can discard every source result. Its admitted read
        // still counts when the cycle publishes settlement.
        passes = nextPass;
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
        taskProjection?: InternalTaskListProjection,
    ): void {
        const previous = lanes.get(sourceInstanceId);
        const observations = retainObservations(previous?.observations ?? [], admitted);
        lanes.set(sourceInstanceId, {
            lane,
            observations,
            taskProjection: reconcileTaskProjection(sourceInstanceId, taskProjection, observations),
            error: laneError,
            completedAtMs: previous?.completedAtMs ?? null,
        });
    }

    /** Keep page adjuncts with the exact lane membership whose records admitted them. */
    function reconcileTaskProjection(sourceInstanceId: string, incoming: InternalTaskListProjection | undefined,
        observations: readonly CorpusQualifiedObservationV1[]): InternalTaskListProjection | undefined {
        const previous = lanes.get(sourceInstanceId)?.taskProjection;
        if (incoming === undefined) return previous;
        const keys = new Set(observations.map(observation => triageEntryRowKey(observation.entryRef)));
        const entries = new Map(previous?.entries.map(entry => [triageEntryRowKey(entry.entryRef), entry]));
        for (const entry of incoming.entries) entries.set(triageEntryRowKey(entry.entryRef), entry);
        const order = incoming.order ?? previous?.order;
        const personalIds = new Set(observations.filter(observation => observation.entryRef.collisionScope === 'personal')
            .map(observation => observation.entryRef.entryId));
        return { ...incoming,
            entries: [...entries].filter(([key]) => keys.has(key)).map(([, entry]) => entry),
            ...(order === undefined ? {} : { order: { scope: order.scope,
                undoneOrder: [...new Set(activeCycleIsAppend
                    ? [...(previous?.order?.undoneOrder ?? []), ...(incoming.order?.undoneOrder ?? [])]
                    : [...(incoming.order?.undoneOrder ?? []), ...(previous?.order?.undoneOrder ?? [])])].filter(id => personalIds.has(id)),
            } }),
        };
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
            merged.set(key, retainTriageObservation(earlier,
                earlier === undefined || !sameWalk ? observation : layerWalkAnswer(earlier, observation)));
        }
        const values = [...merged.values()];
        const capacity = retainedObservationCapacity();
        return Object.freeze(
            values.length <= capacity ? values : values.slice(values.length - capacity),
        );
    }

    /** A completed walk replaces membership while preserving equal answers from its prior retained lane. */
    function reconcileAdmittedObservations(
        retained: readonly CorpusQualifiedObservationV1[],
        admitted: readonly CorpusQualifiedObservationV1[],
    ): readonly CorpusQualifiedObservationV1[] {
        const previous = new Map(retained.map(observation => [triageEntryRowKey(observation.entryRef), observation]));
        return retainTriageProjectionArray(retained, admitted.map(observation =>
            retainTriageObservation(previous.get(triageEntryRowKey(observation.entryRef)), observation)));
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
     * pass is held by a provider retry deadline never re-sets it. Without a
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
        const sourceRefresh = pendingSourceRefresh;
        pendingSourceRefresh = undefined;
        // Each cycle consumes the demand that produced it. Demand arriving
        // while it runs is retained by the same coalesced scheduler.
        pendingTrigger = 'view';
        pending = window === null ? 'initial' : 'refresh';
        publish();

        try {
            // Enumerating configured instances is a Collection read; it reaches no
            // provider, which is what lets a cold mount and the Composer picker
            // be visibly unsynchronized instead of falsely empty.
            const enumeration = sourceRefresh ? { configuredSources, configuredSourcesStatus } : await enumerateConfiguredSources();
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
            for (const summary of acquisitionSources()) {
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

        const availableSourceInstanceIds = acquisitionSources()
            .filter((summary) => summary.available && (!sourceRefresh || lens.sort !== undefined || sourceRefresh.has(summary.sourceInstanceId)))
            .map((summary) => summary.sourceInstanceId);
        const firstUnvisitedSourceIndex = (windowsRequested - 1) * MAX_TRIAGE_LIST_WINDOW_ROWS_V1;
        const appendSourceInstanceIds = cycleWasAppend
            ? lens.sort !== undefined
                ? availableSourceInstanceIds.filter(id => continuations.has(id) || lanes.get(id)?.lane.exhausted !== true)
                : [...new Set([
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
            // the mounted lane map and is taken first by Load More. Explicit sort
            // needs every live head in one aggregate request before cutting rows.
            sourceInstanceIds: lens.sort === undefined
                ? appendSourceInstanceIds.slice(0, MAX_TRIAGE_LIST_WINDOW_ROWS_V1)
                : appendSourceInstanceIds,
            requireAllSources: lens.sort !== undefined,
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
        rowSubscriptions.clear();
        foldBaseline.entries.clear();
        foldBaseline.activeSourceInstanceIds?.clear();
        foldBaseline.window = null;
    }

    publish();

    return Object.freeze({
        getSnapshot: readSnapshot,
        getRow(key) {
            return foldBaseline.entries.get(key)?.row ?? null;
        },
        subscribeRow(key, listener) {
            let subscription = rowSubscriptions.get(key);
            if (subscription === undefined) {
                subscription = { row: foldBaseline.entries.get(key)?.row ?? null, listeners: new Set() };
                rowSubscriptions.set(key, subscription);
            }
            subscription.listeners.add(listener);
            return () => {
                subscription.listeners.delete(listener);
                if (subscription.listeners.size === 0) rowSubscriptions.delete(key);
            };
        },
        publishObservation(observation, keepViewerFacts = false, options) {
            if (!isCurrent()) return null;
            const lane = lanes.get(observation.sourceInstanceId);
            if (lane === undefined) return null;
            const key = triageEntryRowKey(observation.entryRef);
            const previous = foldBaseline.entries.get(key)?.row ?? null;
            if (options?.reconcileMembership && observation.outcome.kind === 'absent') {
                lane.observations = lane.observations.filter(value => triageEntryRowKey(value.entryRef) !== key);
                if (lane.walkObservations !== undefined) lane.walkObservations = lane.walkObservations.filter(value => triageEntryRowKey(value.entryRef) !== key);
                rebuild();
                publish();
                return foldBaseline.entries.get(key)?.row ?? null;
            }
            if (previous === null && !options?.reconcileMembership) return null;
            const row = foldTriagePostMutationObservation({
                row: previous,
                observation,
                lanes: [...lanes.values()].map(value => value.lane),
                activeSourceInstanceIds: acquisitionSources().filter(source => source.available).map(source => source.sourceInstanceId),
                assembledAtMs: observation.observedAtMs,
                keepViewerFacts,
            });
            if (row === null) return null;
            const replacement = row.observations.find(value => value.sourceInstanceId === observation.sourceInstanceId);
            if (replacement === undefined) return null;
            const qualified = { ...replacement, entryRef: observation.entryRef };
            const replace = (observations: readonly CorpusQualifiedObservationV1[]) => [
                ...observations.filter(value => triageEntryRowKey(value.entryRef) !== key), qualified,
            ];
            // Keep the acquired source order, admitting a new pushed member at
            // its end until the next ordinary source-ranked acquisition.
            if (orderedEntryKeys !== null && !orderedEntryKeys.includes(key)) orderedEntryKeys = [...orderedEntryKeys, key];
            lane.observations = replace(lane.observations);
            if (lane.walkObservations !== undefined) lane.walkObservations = replace(lane.walkObservations);
            // The exact fold also owns last-good presentation for an unresolved read.
            // Reuse that row in the retained fold rather than qualifying its observations twice.
            foldBaseline.entries.set(key, { row, searchText: projectTriageEntrySearchText(row.observations) });
            if (row !== previous) {
                changedRowKeys.add(key);
                deps.onRowProjected?.(row.entryRef);
            }
            rebuild();
            publish();
            return foldBaseline.entries.get(key)?.row ?? null;
        },
        project(nextLens) {
            return window === null ? undefined : projectRetained(nextLens, false);
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        refresh(trigger) {
            pendingSourceRefresh = undefined;
            if (!isCurrent()) return Promise.resolve();
            // Concurrent view consumers need the same read. Join before changing
            // reset/trigger intent; manual Refresh still queues a fresh cycle.
            if (trigger === 'view' && pending !== 'idle') return scheduler.flush({ ifRunning: 'join' });
            pagingResetPending = true;
            // Manual Refresh is the strongest intent in a coalesced cycle, so it
            // never loses to a view trigger that arrived first.
            if (trigger === 'manual' || pendingTrigger !== 'manual') pendingTrigger = trigger;
            return scheduler.flush();
        },
        refreshSources(sourceInstanceIds) {
            if (!isCurrent() || window === null || sourceInstanceIds.length === 0) return Promise.resolve();
            if (!pagingResetPending) {
                pendingSourceRefresh ??= new Set();
                for (const id of sourceInstanceIds) pendingSourceRefresh.add(id);
            }
            return scheduler.flush();
        },
        loadMore() {
            pendingSourceRefresh = undefined;
            if (!isCurrent()) return Promise.resolve();
            // Nothing to append to. A mount with no window has not read a
            // connection yet, and the first read is `refresh`'s to make.
            if (window === null) return Promise.resolve();
            // One append at a time, and the published arm says so: the two read
            // the same flag, so a row can never offer a press this refuses.
            if (appending) return Promise.resolve();
            // Replacement clears predecessor frontiers before publication.
            // Wait for that queued read, then allow its healthy continuations
            // independently of failed lanes retaining old membership.
            if (pagingResetPending) return Promise.resolve();
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
            // The reader pressed a row, so this is explicit demand. The source's
            // own retry deadline still publishes through `refreshBlocked`.
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
            // Text, facets, order and Smart policy project retained pages without
            // replacing their provider walk or its continuation.
            const acquisitionChanged = !sameAcquisitionLens(lens, next, configuredSources);
            lens = next;
            if (acquisitionChanged) {
                coordinator.cancel();
                // Invalidate admission before publishing the newly projected
                // lens. Subscribers run synchronously inside `publish`; doing
                // this afterwards briefly offered the predecessor frontier and
                // the imperative path would have accepted that press too.
                resetPagingGeneration({ replacesGeneration: true });
                pagingResetPending = true;
                pendingTrigger = 'manual';
            }
            if (window !== null) rebuild();
            publish();
            // A cold consumer binds its lens before any named page demand.
            // A failed initial demand still needs the reader's replacement;
            // only a never-demanded cold window stays passive.
            if (acquisitionChanged && (window !== null || pending !== 'idle' || error !== null)) {
                scheduler.trigger();
            }
        },
        dispose,
    } satisfies TriageListWindowStoreV1);
}

/**
 * Producers retain semantic values. Only actual scalar/reference changes notify subscribers.
 */
function sameTriageListWindowSnapshot(left: TriageListWindowSnapshotV1, right: TriageListWindowSnapshotV1): boolean {
    return left.window === right.window && left.error === right.error && left.taskProjection === right.taskProjection
        && left.freshness === right.freshness && left.completedAtMs === right.completedAtMs
        && left.pending === right.pending && left.passes === right.passes
        && left.loadMore === right.loadMore && left.refreshBlocked === right.refreshBlocked
        && left.unreadableSources === right.unreadableSources && left.configuredSources === right.configuredSources;
}
