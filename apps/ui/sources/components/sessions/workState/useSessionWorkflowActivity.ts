import * as React from 'react';

import type {
    SessionWorkflowActivityHeadlineV1,
    SessionWorkflowRunHeadlineV1,
    SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import { observeWorkflowRunSnapshot } from '@/sync/ops/sessionWorkflowActivity';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storage';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';

import {
    readSessionWorkflowActivityHeadlineFromMetadata,
    projectWorkflowRunDetail,
    resolveActiveWorkflowRunHeadlines,
} from './sessionWorkflowActivityPresentation';
import type { WorkflowRunDetailState } from './sessionWorkflowActivityTypes';

/**
 * Live workflow activity reader hook (UIW1).
 *
 * Reads the compact headline from Session metadata and observes the shared System Record repository for
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
    ownerKey: string;
    detail: WorkflowRunDetailState;
}>;

function runFetchKey(run: SessionWorkflowRunHeadlineV1): string {
    return `${run.runId}::${run.recordRevision}::${run.recordUpdatedAt}`;
}

export function resolveWorkflowRunHeadlineForToolUseId(metadata: unknown, toolUseId: string | null | undefined): SessionWorkflowRunHeadlineV1 | null {
    const id = toolUseId?.trim();
    const headline = readSessionWorkflowActivityHeadlineFromMetadata(metadata);
    if (!id || !headline) return null;
    const allRuns = [...headline.activeRuns, ...(headline.recentRuns ?? [])];
    return allRuns.find((run) => run.workflowToolUseId === id)
        ?? allRuns.find((run) => run.runId === id)
        ?? null;
}

export function useSessionWorkflowActivity(params: Readonly<{
    sessionId: string;
    serverId?: string;
    metadata: unknown;
    enabled?: boolean;
}>): SessionWorkflowActivityState {
    const accountScope = storage((state) => state.profileScope);
    const serverId = params.serverId;
    const ownerKey = JSON.stringify([accountScope?.serverId, accountScope?.accountId, serverId, params.sessionId]);
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
    const observers = React.useRef(new Map<string, Readonly<{ fetchKey: string; ownerKey: string; unsubscribe: () => void }>>());
    React.useEffect(() => () => {
        for (const observer of observers.current.values()) observer.unsubscribe();
        observers.current.clear();
    }, []);
    React.useEffect(() => {
        for (const [runId, observer] of observers.current) {
            const run = activeRuns.find((candidate) => candidate.runId === runId);
            if (!enabled || !run || observer.ownerKey !== ownerKey || observer.fetchKey !== runFetchKey(run)) {
                observer.unsubscribe();
                observers.current.delete(runId);
            }
        }
        if (!enabled || activeRuns.length === 0) {
            setDetailByRunId(new Map());
            return;
        }
        const session = normalizeSessionAddress(serverId, params.sessionId);
        const capturedAccountScope = accountScope;

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
                    ownerKey,
                    detail: session
                        ? (existing?.ownerKey === ownerKey ? existing.detail : null) ?? { state: 'loading', runId: run.runId }
                        : { state: 'missing', runId: run.runId, reason: 'offline' },
                });
            }
            return next;
        });

        for (const run of activeRuns) {
            const key = runFetchKey(run);
            if (!session || observers.current.has(run.runId)) continue;
            const unsubscribe = observeWorkflowRunSnapshot({ session, runId: run.runId, onChange: (result) => {
                if (!areServerAccountScopesEqual(storage.getState().profileScope, capturedAccountScope)) return;
                setDetailByRunId((prev) => {
                    const existingEntry = prev.get(run.runId);
                    if (!existingEntry || existingEntry.fetchKey !== key || existingEntry.ownerKey !== ownerKey) return prev;
                    const detail = projectWorkflowRunDetail(run.runId, result, existingEntry.detail);
                    if (detail === existingEntry.detail) return prev;
                    const next = new Map(prev);
                    next.set(run.runId, { fetchKey: key, ownerKey, detail });
                    return next;
                });
            } });
            observers.current.set(run.runId, { fetchKey: key, ownerKey, unsubscribe });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchSignature is the narrow key
    }, [enabled, fetchSignature, ownerKey]);

    const runDetailById = React.useMemo(() => {
        const byRunId = new Map<string, WorkflowRunDetailState>();
        for (const run of activeRuns) {
            const entry = detailByRunId.get(run.runId);
            byRunId.set(run.runId, (entry?.ownerKey === ownerKey ? entry.detail : null) ?? { state: 'loading', runId: run.runId });
        }
        return byRunId;
    }, [activeRuns, detailByRunId, ownerKey]);

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
    serverId?: string;
    metadata: unknown;
    toolUseId: string | null | undefined;
}>): Readonly<{
    runHeadline: SessionWorkflowRunHeadlineV1 | null;
    detail: WorkflowRunDetailState | null;
}> {
    const accountScope = storage((state) => state.profileScope);
    const serverId = params.serverId;
    const ownerKey = JSON.stringify([accountScope?.serverId, accountScope?.accountId, serverId, params.sessionId]);
    const runHeadline = React.useMemo(
        () => resolveWorkflowRunHeadlineForToolUseId(params.metadata, params.toolUseId),
        [params.metadata, params.toolUseId],
    );

    // Narrow fetch key: run id + record revision/updatedAt. Refetches only when the matched run's
    // durable record advances, not on unrelated headline churn.
    const fetchKey = runHeadline ? runFetchKey(runHeadline) : null;
    const runId = runHeadline?.runId ?? null;
    const [detailState, setDetailState] = React.useState<Readonly<{ ownerKey: string; detail: WorkflowRunDetailState }> | null>(null);
    const detail = detailState?.ownerKey === ownerKey ? detailState.detail : null;

    React.useEffect(() => {
        if (!runId || !fetchKey) {
            setDetailState(null);
            return;
        }
        const session = normalizeSessionAddress(serverId, params.sessionId);
        if (!session) {
            setDetailState({ ownerKey, detail: { state: 'missing', runId, reason: 'offline' } });
            return;
        }
        const capturedAccountScope = accountScope;
        setDetailState((prev) => (prev?.ownerKey === ownerKey && prev.detail.runId === runId ? prev : { ownerKey, detail: { state: 'loading', runId } }));
        return observeWorkflowRunSnapshot({ session, runId, onChange: (result) => {
            if (!areServerAccountScopesEqual(storage.getState().profileScope, capturedAccountScope)) return;
            setDetailState((prev) => ({ ownerKey, detail: projectWorkflowRunDetail(runId, result, prev?.ownerKey === ownerKey ? prev.detail : null) }));
        } });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchKey is the narrow key
    }, [fetchKey, ownerKey]);

    return { runHeadline, detail };
}
