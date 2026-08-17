import type { Disposable, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { createCoalescedScheduler } from '@happier-dev/plugin-sdk/async';

import type { CorpusQualifiedObservationV1 } from '../corpus/fold/qualify.js';
import { laneObservationsFromWire } from './listWindowWire.js';
import {
    createTriageRefreshCoordinator,
    type TriageRefreshCoordinatorV1,
    type TriageRefreshPassOutcomeV1,
} from '../refresh/refreshCoordinator.js';
import {
    TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS,
    type TriageRefreshTriggerV1,
} from '../refresh/refreshEligibility.js';
import type {
    TriageListEntriesInputV1,
    TriageListEntriesResultV1,
} from '../actions/listEntriesProtocol.js';
import {
    TRIAGE_LIST_DEFAULT_LENS_V1,
    foldTriageListWindow,
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

export type TriageListWindowSnapshotV1 = Readonly<{
    /** The last admitted window. Retained across a failed refresh. */
    window?: TriageListWindowV1;
    freshness: 'unknown' | 'fresh' | 'stale';
    pending: 'idle' | 'initial' | 'refresh';
    /** Retained beside the value, never instead of it. */
    error?: TriageListWindowErrorV1;
    /** Every configured source instance, including ones with no admitted contribution. */
    configuredSources: TriageListEntriesResultV1['configuredSources'];
}>;

export type TriageListWindowStoreV1 = Readonly<{
    getSnapshot(): TriageListWindowSnapshotV1;
    subscribe(listener: () => void): () => void;
    /** The only way a consumer causes provider work. */
    refresh(trigger: TriageRefreshTriggerV1): Promise<void>;
    /** A lens change rebuilds the window from retained observations and marks it stale. */
    setLens(lens: TriageListLensV1): void;
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

function errorFrom(cause: unknown): TriageListWindowErrorV1 {
    if (cause instanceof Error) {
        return { code: 'plugin_action_failed', message: cause.message };
    }
    return { code: 'plugin_action_failed', message: 'The list could not be read.' };
}

export function createTriageListWindowStore(deps: Readonly<{
    readEntries: TriageListWindowReaderV1;
    nowMs: () => number;
    lens?: TriageListLensV1;
    lifetime?: TriageListWindowLifetimeV1;
    onUnexpectedError?: (error: unknown) => void;
}>): TriageListWindowStoreV1 {
    const listeners = new Set<() => void>();
    const lanes = new Map<string, LaneState>();
    let lens: TriageListLensV1 = deps.lens ?? TRIAGE_LIST_DEFAULT_LENS_V1;
    let configuredSources: TriageListEntriesResultV1['configuredSources'] = [];
    let configuredSourcesStatus: TriageListEntriesResultV1['configuredSourcesStatus'] = 'complete';
    let window: TriageListWindowV1 | null = null;
    let error: TriageListWindowErrorV1 | null = null;
    let pending: TriageListWindowSnapshotV1['pending'] = 'idle';
    let lastCycleCompletedAtMs: number | null = null;
    let lensChangedSinceCycle = false;
    let pendingTrigger: TriageRefreshTriggerV1 = 'view';
    let disposed = false;
    let retirement: Disposable | null = null;
    let snapshot: TriageListWindowSnapshotV1 = Object.freeze({
        freshness: 'unknown',
        pending: 'idle',
        configuredSources: Object.freeze([]),
    });

    function isCurrent(): boolean {
        return !disposed && (deps.lifetime?.isCurrent() ?? true);
    }

    function freshness(): TriageListWindowSnapshotV1['freshness'] {
        if (window === null) return 'unknown';
        if (error !== null || lensChangedSinceCycle || lastCycleCompletedAtMs === null) return 'stale';
        for (const lane of lanes.values()) {
            if (lane.error !== null) return 'stale';
        }
        return deps.nowMs() - lastCycleCompletedAtMs < TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS
            ? 'fresh'
            : 'stale';
    }

    function publish(): void {
        snapshot = Object.freeze({
            ...(window === null ? {} : { window }),
            freshness: freshness(),
            pending,
            ...(error === null ? {} : { error }),
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
            lens,
            assembledAtMs: deps.nowMs(),
        });
    }

    function scanInputFor(sourceInstanceIds: readonly string[]): TriageListEntriesInputV1 {
        return {
            v: 1,
            sources: { kind: 'selected', sourceInstanceIds },
            limit: lens.limit,
            order: lens.order,
            ...(lens.query === '' ? {} : { query: lens.query }),
            filters: lens.filters,
        };
    }

    function syncConfiguredSources(result: TriageListEntriesResultV1): void {
        configuredSources = result.configuredSources;
        configuredSourcesStatus = result.configuredSourcesStatus;
        const known = new Set(result.configuredSources.map((summary) => summary.sourceInstanceId));
        for (const sourceInstanceId of [...lanes.keys()]) {
            if (known.has(sourceInstanceId)) continue;
            // The row is gone or retired: drop its lane and abort any pass it
            // still owns. A retired instance's late result must not reach the
            // window it no longer belongs in.
            lanes.delete(sourceInstanceId);
            coordinator.retire(sourceInstanceId);
        }
    }

    async function runPass(input: Readonly<{
        sourceInstanceId: string;
        signal: AbortSignal;
    }>): Promise<TriageRefreshPassOutcomeV1> {
        let result: TriageListEntriesResultV1;
        try {
            result = await deps.readEntries(
                scanInputFor([input.sourceInstanceId]),
                { signal: input.signal },
            );
        } catch (cause) {
            if (input.signal.aborted) return { kind: 'interrupted' };
            recordLaneError(input.sourceInstanceId, errorFrom(cause));
            return { kind: 'interrupted' };
        }
        if (!isCurrent()) return { kind: 'interrupted' };

        syncConfiguredSources(result);
        const lane = result.window.lanes.find(
            (candidate) => candidate.sourceInstanceId === input.sourceInstanceId,
        );
        if (lane === undefined) {
            // The instance was not invocable in this pass. Its retained window
            // stays exactly as it was.
            return { kind: 'interrupted' };
        }

        if (lane.health.kind === 'failed') {
            recordLaneFailure(input.sourceInstanceId, lane, {
                code: lane.health.failure.code,
                message: lane.health.failure.detail ?? lane.health.failure.class,
            });
            return { kind: 'failed', failure: lane.health.failure };
        }
        if (lane.health.kind === 'unavailable') {
            recordLaneFailure(input.sourceInstanceId, lane, {
                code: 'source_unavailable',
                message: 'The source could not be read in this pass.',
            });
            return { kind: 'interrupted' };
        }

        lanes.set(input.sourceInstanceId, {
            lane,
            observations: laneObservationsFromWire(result, input.sourceInstanceId),
            error: null,
            completedAtMs: deps.nowMs(),
        });
        return { kind: 'completed' };
    }

    /** A failed lane keeps the entries it last admitted; only its health changes. */
    function recordLaneFailure(
        sourceInstanceId: string,
        lane: TriageListLaneV1,
        laneError: TriageListWindowErrorV1,
    ): void {
        const previous = lanes.get(sourceInstanceId);
        lanes.set(sourceInstanceId, {
            lane,
            observations: previous?.observations ?? [],
            error: laneError,
            completedAtMs: previous?.completedAtMs ?? null,
        });
        error = laneError;
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
     */
    function recordLaneError(sourceInstanceId: string, laneError: TriageListWindowErrorV1): void {
        const previous = lanes.get(sourceInstanceId);
        if (previous !== undefined) {
            lanes.set(sourceInstanceId, { ...previous, error: laneError });
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
                    observations: [],
                    error: laneError,
                    completedAtMs: null,
                });
            }
        }
        error = laneError;
    }

    const coordinator: TriageRefreshCoordinatorV1 = createTriageRefreshCoordinator({
        runPass,
        nowMs: deps.nowMs,
        ...(deps.onUnexpectedError ? { onUnexpectedError: deps.onUnexpectedError } : {}),
    });

    async function runCycle(): Promise<void> {
        if (!isCurrent()) return;
        const trigger = pendingTrigger;
        pending = window === null ? 'initial' : 'refresh';
        publish();

        try {
            // Enumerating configured instances is a Collection read; it reaches no
            // provider, which is what lets a cold mount and the Composer picker
            // be visibly unsynchronized instead of falsely empty.
            const enumeration = await deps.readEntries(scanInputFor([]));
            if (!isCurrent()) return;
            syncConfiguredSources(enumeration);
            error = null;
        } catch (cause) {
            error = errorFrom(cause);
            pending = 'idle';
            publish();
            return;
        }

        await Promise.all(configuredSources
            .filter((summary) => summary.available)
            .map(async (summary) => {
                await coordinator.request({
                    sourceInstanceId: summary.sourceInstanceId,
                    trigger,
                }).settled;
            }));

        if (!isCurrent()) return;
        lastCycleCompletedAtMs = deps.nowMs();
        lensChangedSinceCycle = false;
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
            // Manual Refresh is the strongest intent in a coalesced cycle, so it
            // never loses to a view trigger that arrived first.
            if (trigger === 'manual' || pendingTrigger !== 'manual') pendingTrigger = trigger;
            return scheduler.flush();
        },
        setLens(next) {
            lens = next;
            lensChangedSinceCycle = true;
            if (window !== null) rebuild();
            publish();
        },
        dispose,
    } satisfies TriageListWindowStoreV1);
}
