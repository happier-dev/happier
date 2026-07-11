import * as React from 'react';

import type {
    SessionWorkflowActivityHeadlineV1,
    SessionWorkflowRunHeadlineV1,
    SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import { fetchWorkflowRunSnapshot } from '@/sync/domains/sessionActivity/sessionWorkflowActivityRecords';

import {
    readSessionWorkflowActivityHeadlineFromMetadata,
    resolveActiveWorkflowRunHeadlines,
} from './sessionWorkflowActivityPresentation';
import type { WorkflowRunDetailState } from './sessionWorkflowActivityTypes';

/**
 * Live workflow activity reader hook (UIW1).
 *
 * Reads the compact headline from session metadata (the only live invalidation pointer) and fetches
 * the matching durable `activity/workflow_run.v1` system record for each run whose
 * `recordRevision`/`recordUpdatedAt` changes. The fetch signature is narrow — keyed by
 * `runId:recordRevision:recordUpdatedAt` — so a progress tick that does not advance a run's record
 * revision does not refetch, and two active runs refetch independently without cross-pollution.
 */

export type SessionWorkflowActivityState = Readonly<{
    headline: SessionWorkflowActivityHeadlineV1 | null;
    activeRuns: readonly SessionWorkflowRunHeadlineV1[];
    runDetailById: ReadonlyMap<string, WorkflowRunDetailState>;
    loadedRunsById: ReadonlyMap<string, SessionWorkflowRunSnapshotV1>;
}>;

type WorkflowRunDetailEntry = Readonly<{
    fetchKey: string;
    detail: WorkflowRunDetailState;
}>;

function runFetchKey(run: SessionWorkflowRunHeadlineV1): string {
    return `${run.runId}::${run.recordRevision}::${run.recordUpdatedAt}`;
}

export function useSessionWorkflowActivity(params: Readonly<{
    sessionId: string;
    metadata: unknown;
    enabled?: boolean;
}>): SessionWorkflowActivityState {
    const enabled = params.enabled ?? true;
    const headline = React.useMemo(
        () => (enabled ? readSessionWorkflowActivityHeadlineFromMetadata(params.metadata) : null),
        [enabled, params.metadata],
    );
    const activeRuns = React.useMemo(() => resolveActiveWorkflowRunHeadlines(headline), [headline]);

    // The narrow fetch signature: only changes when a run is added/removed or its record revision /
    // updatedAt advances. Memoizing on this avoids refetching on unrelated headline churn.
    const fetchSignature = React.useMemo(
        () => activeRuns.map(runFetchKey).join('|'),
        [activeRuns],
    );

    const [detailByRunId, setDetailByRunId] = React.useState<ReadonlyMap<string, WorkflowRunDetailEntry>>(new Map());
    const detailByRunIdRef = React.useRef(detailByRunId);

    React.useEffect(() => {
        detailByRunIdRef.current = detailByRunId;
    }, [detailByRunId]);

    React.useEffect(() => {
        if (!enabled || activeRuns.length === 0) {
            setDetailByRunId(new Map());
            return;
        }
        let cancelled = false;

        // Seed by run id, not by revision key. A revision advance should keep the previous loaded
        // snapshot visible while the newer record is fetched (stale-while-revalidate), so workflow
        // panels do not flash empty during active progress updates.
        setDetailByRunId((prev) => {
            const next = new Map<string, WorkflowRunDetailEntry>();
            for (const run of activeRuns) {
                const key = runFetchKey(run);
                const existing = prev.get(run.runId);
                next.set(run.runId, {
                    fetchKey: key,
                    detail: existing?.detail ?? { state: 'loading', runId: run.runId },
                });
            }
            return next;
        });

        for (const run of activeRuns) {
            const key = runFetchKey(run);
            const existing = detailByRunIdRef.current.get(run.runId);
            if (existing?.fetchKey === key) continue;
            void fetchWorkflowRunSnapshot({ sessionId: params.sessionId, runId: run.runId })
                .then((snapshot) => {
                    if (cancelled) return;
                    setDetailByRunId((prev) => {
                        const existingEntry = prev.get(run.runId);
                        if (!existingEntry || existingEntry.fetchKey !== key) return prev;
                        const next = new Map(prev);
                        next.set(run.runId, {
                            fetchKey: key,
                            detail: snapshot
                                ? { state: 'loaded', runId: run.runId, snapshot }
                                : { state: 'missing', runId: run.runId },
                        });
                        return next;
                    });
                })
                .catch(() => {
                    if (cancelled) return;
                    setDetailByRunId((prev) => {
                        const existingEntry = prev.get(run.runId);
                        if (!existingEntry || existingEntry.fetchKey !== key) return prev;
                        const next = new Map(prev);
                        next.set(run.runId, {
                            fetchKey: key,
                            detail: { state: 'missing', runId: run.runId },
                        });
                        return next;
                    });
                });
        }

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchSignature is the narrow key
    }, [enabled, fetchSignature, params.sessionId]);

    const runDetailById = React.useMemo(() => {
        const byRunId = new Map<string, WorkflowRunDetailState>();
        for (const run of activeRuns) {
            const entry = detailByRunId.get(run.runId);
            byRunId.set(run.runId, entry?.detail ?? { state: 'loading', runId: run.runId });
        }
        return byRunId;
    }, [activeRuns, detailByRunId]);

    const loadedRunsById = React.useMemo(() => {
        const byRunId = new Map<string, SessionWorkflowRunSnapshotV1>();
        for (const [runId, detail] of runDetailById) {
            if (detail.state === 'loaded') byRunId.set(runId, detail.snapshot);
        }
        return byRunId;
    }, [runDetailById]);

    // Referential stability: the wrapper only changes when one of its memoized members changes, so
    // consumers (e.g. the SessionView badge memo) do not recompute on every render.
    return React.useMemo(
        () => ({ headline, activeRuns, runDetailById, loadedRunsById }),
        [headline, activeRuns, runDetailById, loadedRunsById],
    );
}

/**
 * Single-run variant used by the transcript card, which joins by its OWN tool-use id. Resolves the
 * run headline whose `workflowToolUseId` (preferred) or `runId` (fallback) matches the tool-use id —
 * across BOTH active and recent runs so a completed workflow card still renders — then fetches and
 * exposes that run's loading/loaded/missing detail state. Does not default to the headline
 * `primaryRunId` when the tool id maps to a different run.
 */
export function useWorkflowRunForToolUseId(params: Readonly<{
    sessionId: string;
    metadata: unknown;
    toolUseId: string | null | undefined;
}>): Readonly<{
    runHeadline: SessionWorkflowRunHeadlineV1 | null;
    detail: WorkflowRunDetailState | null;
}> {
    const headline = React.useMemo(
        () => readSessionWorkflowActivityHeadlineFromMetadata(params.metadata),
        [params.metadata],
    );
    const runHeadline = React.useMemo(() => {
        const toolUseId = params.toolUseId?.trim();
        if (!toolUseId || !headline) return null;
        const allRuns = [...headline.activeRuns, ...(headline.recentRuns ?? [])];
        return (
            allRuns.find((run) => run.workflowToolUseId === toolUseId)
            ?? allRuns.find((run) => run.runId === toolUseId)
            ?? null
        );
    }, [headline, params.toolUseId]);

    // Narrow fetch key: run id + record revision/updatedAt. Refetches only when the matched run's
    // durable record advances, not on unrelated headline churn.
    const fetchKey = runHeadline ? runFetchKey(runHeadline) : null;
    const runId = runHeadline?.runId ?? null;
    const [detail, setDetail] = React.useState<WorkflowRunDetailState | null>(null);

    React.useEffect(() => {
        if (!runId || !fetchKey) {
            setDetail(null);
            return;
        }
        let cancelled = false;
        setDetail((prev) => (prev && prev.runId === runId ? prev : { state: 'loading', runId }));
        void fetchWorkflowRunSnapshot({ sessionId: params.sessionId, runId })
            .then((snapshot) => {
                if (cancelled) return;
                setDetail(snapshot
                    ? { state: 'loaded', runId, snapshot }
                    : { state: 'missing', runId });
            })
            .catch(() => {
                if (cancelled) return;
                setDetail({ state: 'missing', runId });
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchKey is the narrow key
    }, [fetchKey, params.sessionId]);

    return { runHeadline, detail };
}
