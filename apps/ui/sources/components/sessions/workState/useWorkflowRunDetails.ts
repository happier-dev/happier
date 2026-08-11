import * as React from 'react';

import {
    readSessionAgentActivityHeadlineFromMetadata,
    type SessionAgentActivityHeadlineV1,
    type SessionWorkflowActivityHeadlineV1,
    type SessionWorkflowRunHeadlineV1,
    type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import { readAgentActivityEvidenceIndexFromHeadline } from '@/sync/domains/session/agentActivity';
import { fetchWorkflowRunSnapshot } from '@/sync/domains/sessionActivity/sessionWorkflowActivityRecords';

import { readSessionWorkflowActivityHeadlineFromMetadata } from './sessionWorkflowActivityPresentation';
import type { WorkflowRunDetailState } from './sessionWorkflowActivityTypes';

/**
 * Run DETAIL, behind the one model that owns existence (r4.1).
 *
 * **What changed and why.** This hook used to decide which workflow runs a session had, by reading
 * `sessionWorkflowActivityHeadlineV1` itself. That made it a second existence owner beside
 * `sync/domains/session/agentActivity`, which reads the unified headline projected from the *same*
 * committed snapshots — one concept, two models, one per surface. Existence, status and ordering
 * now come from the unified model; this hook is handed the run ids it should hydrate and answers
 * only "what do we know in depth about this run".
 *
 * **It must not be deleted.** The unified headline carries no phases, no per-agent provider metrics,
 * no summary, no result preview and no producer-supplied agent fraction (`AgentActivityEntry` is
 * explicitly barred from numeric rollup over children). Reading the popover off the headline alone
 * would silently strip all of that from every workflow row. The durable `activity/workflow_run.v1`
 * record is the only source, and this is the seam that fetches it.
 *
 * Both published headlines are still read here — as DETAIL, never as existence. They supply the
 * narrow fetch key, so a progress tick that does not advance a run's record does not refetch, and
 * two active runs refetch independently.
 */

export type WorkflowRunDetails = Readonly<{
    runDetailById: ReadonlyMap<string, WorkflowRunDetailState>;
    loadedRunsById: ReadonlyMap<string, SessionWorkflowRunSnapshotV1>;
    /**
     * The run headline behind a run id, when the session publishes one.
     *
     * Pre-load fallback only: it supplies a title and an agent fraction before the durable record
     * lands. Once the snapshot is loaded, every count comes from the snapshot — from the producer,
     * never summed from the entries beneath it (N-USAGE).
     */
    runHeadlineById: ReadonlyMap<string, SessionWorkflowRunHeadlineV1>;
}>;

type WorkflowRunDetailEntry = Readonly<{
    fetchKey: string;
    detail: WorkflowRunDetailState;
}>;

function runFetchKey(run: SessionWorkflowRunHeadlineV1): string {
    return `${run.runId}::${run.recordRevision}::${run.recordUpdatedAt}`;
}

/**
 * Both published activity headlines, parsed ONCE per metadata identity.
 *
 * Each is a zod parse over session metadata that arrives on every sync tick, and this module needs
 * the workflow one twice (the pre-load fraction and the fetch key). Parsing per consumer is how the
 * same metadata ends up decoded three times a tick for one open session.
 */
type MetadataActivityHeadlines = Readonly<{
    workflow: SessionWorkflowActivityHeadlineV1 | null;
    agentActivity: SessionAgentActivityHeadlineV1 | null;
}>;

function readActivityHeadlines(metadata: unknown): MetadataActivityHeadlines {
    return {
        workflow: readSessionWorkflowActivityHeadlineFromMetadata(metadata),
        agentActivity: readSessionAgentActivityHeadlineFromMetadata(metadata),
    };
}

/**
 * What a run's durable record is keyed by, from whichever headline its producer published.
 *
 * **Why both are read.** The count-only workflow headline is written by ONE backend's CLI, and PLAN
 * §5.2 has the unified headline standing on its own. This hook had no record pointer at all on that
 * path, so it degraded to a per-run constant: the run hydrated ONCE and never refreshed again while
 * the panel above it went on looking live. A monitoring surface that quietly stops updating is a
 * trust failure, and it is invisible — nothing errors, nothing spins, the numbers simply stop being
 * true.
 *
 * The two keys are derived from the SAME committed snapshots, so preferring the workflow one when
 * both exist is not a tie-break between disagreeing sources — it is the richer spelling of one fact.
 *
 * **Still not an existence owner.** This resolves a cache key for runs the CALLER already decided to
 * show; a run named by a headline the caller did not ask for is never hydrated (see the demotion
 * test). Reading metadata here is the same DETAIL read the workflow headline was always given.
 *
 * A unified entry that carries no `recordRevision` — a producer predating that field, which becomes
 * reachable as soon as a CLI and an app build can differ — falls back to its evidence instant. That
 * refetches somewhat more eagerly than a revision would, because evidence advances on display-only
 * changes too; refetching more often than necessary is a bounded cost, while never refetching is a
 * wrong answer that looks right.
 */
function resolveRunFetchKeys(headlines: MetadataActivityHeadlines): ReadonlyMap<string, string> {
    const byRunId = new Map<string, string>();
    if (headlines.workflow) {
        for (const run of [...headlines.workflow.activeRuns, ...(headlines.workflow.recentRuns ?? [])]) {
            if (!byRunId.has(run.runId)) byRunId.set(run.runId, runFetchKey(run));
        }
    }
    if (headlines.agentActivity) {
        const entries = [
            ...headlines.agentActivity.activeEntries,
            ...(headlines.agentActivity.recentEntries ?? []),
        ];
        for (const entry of entries) {
            // Only a run entry points at `activity/workflow_run.v1`. An agent lives INSIDE that
            // record and carries no revision of its own, by design at the producer.
            if (entry.kind !== 'workflow_run') continue;
            const runId = entry.runId;
            if (runId === undefined || byRunId.has(runId)) continue;
            byRunId.set(runId, entry.recordRevision !== undefined
                ? `${runId}::rev::${entry.recordRevision}`
                : `${runId}::evidence::${entry.updatedAt}`);
        }
    }
    return byRunId;
}

/**
 * The key a run is fetched under.
 *
 * The fallback is reachable only for a run NO headline names, and no such run can reach this hook
 * today: `workflow_run` is a headline-only kind — every local source derives subagents, execution
 * runs, teammates or background tasks — so a run id in `runIds` was published by one of the two
 * headlines read above. The condition that would invalidate that, and make this branch a freeze
 * again, is a local source that derives a `workflow_run` entry; such a source must also carry a
 * freshness signal for it.
 */
function resolveRunFetchKey(byRunId: ReadonlyMap<string, string>, runId: string): string {
    return byRunId.get(runId) ?? `${runId}::unversioned`;
}

const NO_RUN_IDS: readonly string[] = Object.freeze([]);

export function useWorkflowRunDetails(params: Readonly<{
    sessionId: string;
    metadata: unknown;
    /** The runs the calling surface is actually showing, from the unified model. */
    runIds: readonly string[];
}>): WorkflowRunDetails {
    const { metadata, sessionId } = params;
    const runIds = params.runIds.length > 0 ? params.runIds : NO_RUN_IDS;

    const headlines = React.useMemo(() => readActivityHeadlines(metadata), [metadata]);

    const runHeadlineById = React.useMemo(() => {
        const byRunId = new Map<string, SessionWorkflowRunHeadlineV1>();
        if (!headlines.workflow) return byRunId;
        for (const run of [...headlines.workflow.activeRuns, ...(headlines.workflow.recentRuns ?? [])]) {
            byRunId.set(run.runId, run);
        }
        return byRunId;
    }, [headlines]);

    const runFetchKeyById = React.useMemo(() => resolveRunFetchKeys(headlines), [headlines]);

    // The narrow fetch signature: it changes only when the shown set changes or a run's record
    // does. It is resolved from whichever headline the session's backend publishes, so the
    // unified-only path refreshes like the workflow path rather than freezing after one fetch.
    const fetchSignature = React.useMemo(
        () => runIds.map((runId) => resolveRunFetchKey(runFetchKeyById, runId)).join('|'),
        [runFetchKeyById, runIds],
    );

    const [detailByRunId, setDetailByRunId] = React.useState<ReadonlyMap<string, WorkflowRunDetailEntry>>(new Map());
    const detailByRunIdRef = React.useRef(detailByRunId);

    React.useEffect(() => {
        detailByRunIdRef.current = detailByRunId;
    }, [detailByRunId]);

    React.useEffect(() => {
        if (runIds.length === 0) {
            setDetailByRunId((prev) => (prev.size === 0 ? prev : new Map()));
            return;
        }
        let cancelled = false;

        const keyFor = (runId: string): string => resolveRunFetchKey(runFetchKeyById, runId);

        // Seed by run id, not by revision key. A revision advance should keep the previous loaded
        // snapshot visible while the newer record is fetched (stale-while-revalidate), so workflow
        // panels do not flash empty during active progress updates.
        setDetailByRunId((prev) => {
            const next = new Map<string, WorkflowRunDetailEntry>();
            for (const runId of runIds) {
                const existing = prev.get(runId);
                next.set(runId, {
                    fetchKey: keyFor(runId),
                    detail: existing?.detail ?? { state: 'loading', runId },
                });
            }
            return next;
        });

        for (const runId of runIds) {
            const key = keyFor(runId);
            const existing = detailByRunIdRef.current.get(runId);
            if (existing?.fetchKey === key) continue;
            void fetchWorkflowRunSnapshot({ sessionId, runId })
                .then((snapshot) => {
                    if (cancelled) return;
                    setDetailByRunId((prev) => {
                        const existingEntry = prev.get(runId);
                        if (!existingEntry || existingEntry.fetchKey !== key) return prev;
                        const next = new Map(prev);
                        next.set(runId, {
                            fetchKey: key,
                            detail: snapshot
                                ? { state: 'loaded', runId, snapshot }
                                : { state: 'missing', runId },
                        });
                        return next;
                    });
                })
                .catch(() => {
                    if (cancelled) return;
                    setDetailByRunId((prev) => {
                        const existingEntry = prev.get(runId);
                        if (!existingEntry || existingEntry.fetchKey !== key) return prev;
                        const next = new Map(prev);
                        next.set(runId, { fetchKey: key, detail: { state: 'missing', runId } });
                        return next;
                    });
                });
        }

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchSignature is the narrow key
    }, [fetchSignature, sessionId]);

    const runDetailById = React.useMemo(() => {
        const byRunId = new Map<string, WorkflowRunDetailState>();
        for (const runId of runIds) {
            const entry = detailByRunId.get(runId);
            byRunId.set(runId, entry?.detail ?? { state: 'loading', runId });
        }
        return byRunId;
    }, [detailByRunId, runIds]);

    const loadedRunsById = React.useMemo(() => {
        const byRunId = new Map<string, SessionWorkflowRunSnapshotV1>();
        for (const [runId, detail] of runDetailById) {
            if (detail.state === 'loaded') byRunId.set(runId, detail.snapshot);
        }
        return byRunId;
    }, [runDetailById]);

    // Referential stability: the wrapper only changes when one of its memoized members changes, so
    // consumers do not recompute on every render.
    return React.useMemo(
        () => ({ runDetailById, loadedRunsById, runHeadlineById }),
        [loadedRunsById, runDetailById, runHeadlineById],
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
    /**
     * Freshest evidence per agent-activity entry id, from the headline already parsed here.
     *
     * The card has no roster subscription — it holds a tool call and the session's metadata — and
     * the durable record it draws is refetched on a revision that does not advance for a
     * display-only update. Without this its silence rule reads an older instant than the popover
     * and the run panel do, and the same agent reads stale on one surface and fresh on another.
     * Built from the headline this hook already decodes, so it costs no second parse.
     */
    agentEvidenceAtMsById: ReadonlyMap<string, number>;
}> {
    const headlines = React.useMemo(
        () => readActivityHeadlines(params.metadata),
        [params.metadata],
    );
    const runHeadline = React.useMemo(() => {
        const toolUseId = params.toolUseId?.trim();
        const headline = headlines.workflow;
        if (!toolUseId || !headline) return null;
        const allRuns = [...headline.activeRuns, ...(headline.recentRuns ?? [])];
        return (
            allRuns.find((run) => run.workflowToolUseId === toolUseId)
            ?? allRuns.find((run) => run.runId === toolUseId)
            ?? null
        );
    }, [headlines, params.toolUseId]);

    const directRunId = React.useMemo(() => {
        const toolUseId = params.toolUseId?.trim();
        return toolUseId ? toolUseId : null;
    }, [params.toolUseId]);
    const runFetchKeyById = React.useMemo(() => resolveRunFetchKeys(headlines), [headlines]);
    // Narrow fetch key: headline-backed cards use run id + record revision/updatedAt. Older
    // completed cards that fell out of bounded `recentRuns[]` can still load their durable record by
    // the Workflow tool-use id, which is the run-local record id for persisted transcript cards.
    //
    // That id-only key is a FROZEN key, and it is correct only while the record behind it is
    // finished. A card on a unified-only backend lands here for a LIVE run too — the unified
    // headline carries no `workflowToolUseId`, so the join above cannot resolve it — and it would
    // then show that run's first phase/agent tree for the rest of the run. When either headline
    // knows the run behind this id, its record key wins over the frozen one.
    const runId = runHeadline?.runId ?? directRunId;
    const fetchKey = runHeadline
        ? runFetchKey(runHeadline)
        : directRunId
            ? runFetchKeyById.get(directRunId) ?? `direct::${directRunId}`
            : null;
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

    const agentEvidenceAtMsById = React.useMemo(
        () => readAgentActivityEvidenceIndexFromHeadline(headlines.agentActivity),
        [headlines],
    );

    return { runHeadline, detail, agentEvidenceAtMsById };
}
