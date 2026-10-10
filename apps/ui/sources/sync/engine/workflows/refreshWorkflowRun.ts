import { storage } from '@/sync/domains/state/storage';
import { getWorkflowRunSummary, listWorkflowRuns } from '@/sync/domains/workflows/workflowRunListActions';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import type { WorkflowRunGetResultV1, WorkflowRunListResultV1 } from '@happier-dev/protocol/workflows/actionsV1';

import { materializeWorkflowRunAccountChange } from './materializeWorkflowRunAccountChange';

/** Opened detail uses the same Account body owner as the exact Run screen. Callers fence the read before publication. */
export function publishOpenedWorkflowRunDetail(detail: WorkflowRunGetResultV1): void {
    storage.getState().upsertWorkflowRuns([{ ...workflowRunRowFromSummary(detail.run,
        detail.acceptedContext.metadata ? { kind: 'available', value: detail.acceptedContext.metadata } : null), detail }]);
}

// Only pending reads are shared; the Account's existing Run/fact maps own all resolved content.
const pendingProvenance = new WeakMap<ActiveServerAccountScopeLifetime, Map<string, Promise<void>>>();

function publishInvocationProvenance(run: WorkflowRunListResultV1['runs'][number], facts: WorkflowRunListResultV1['invocationProvenance']): void {
    for (const fact of facts ?? []) {
        if (fact.index.runId !== run.id) continue;
        storage.getState().upsertWorkflowRunInvocation({ runId: run.id, parentRevision: run.revision,
            invocation: { ...fact.index, ...(fact.stepOrdinal ? { stepOrdinal: fact.stepOrdinal } : {}),
                ...(fact.notificationCondition ? { notificationCondition: fact.notificationCondition } : {}), provenanceLoaded: true } });
    }
}

export function refreshWorkflowTranscriptProvenance(
    references: readonly Readonly<{ runId: string; invocationRecordIds: readonly string[] }>[],
): Promise<void> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || references.length === 0) return Promise.resolve();
    const key = JSON.stringify(references);
    let pending = pendingProvenance.get(lifetime);
    if (!pending) { pending = new Map(); pendingProvenance.set(lifetime, pending); }
    const known = pending.get(key);
    if (known) return known;
    const abort = new AbortController();
    const retirement = lifetime.onRetire(() => abort.abort());
    const read = (async () => {
        let cursor: string | undefined;
        do {
            const page = await listWorkflowRuns({ filter: { runIds: references.map(ref => ref.runId),
                invocationProvenance: references.filter(ref => ref.invocationRecordIds.length > 0) },
                ...(cursor ? { cursor } : {}), signal: abort.signal });
            if (!lifetime.isCurrent()) return;
            const state = storage.getState();
            state.upsertWorkflowRuns(page.runs.map(run => workflowRunRowFromSummary(run, page.metadataByRunId[run.id] ?? null)));
            for (const run of page.runs) publishInvocationProvenance(run, page.invocationProvenance);
            cursor = page.nextCursor;
        } while (cursor);
    })().finally(() => { retirement.dispose(); pending.delete(key); });
    pending.set(key, read);
    return read;
}

/**
 * Refresh one exact Run into the Account-scoped `workflowRunsById` owner.
 *
 * This is the single composition of the lean exact-Run summary read, the
 * canonical change materialization and the shared row merge. The Account-change
 * applier invokes it for every `workflow-run:<id>` change; a transcript row that
 * has just observed a start acknowledgement invokes it once so the row is known
 * before the change stream mentions it. Neither keeps a copy: the shared row
 * is the only body, and its revision merge makes a delayed read harmless.
 *
 * The read is the list owner's exact-Run projection — one Run summary plus its
 * sparse private metadata — never the full `workflow.run.get` detail. Full
 * detail pages all invocations and opens every progress envelope to recompute
 * usage, a history-proportional cost no background invalidation or transcript
 * placeholder may pay. Explicit Run detail keeps that read.
 *
 * `fence` is the caller's Account lifetime. A read that completes after that
 * lifetime retired is discarded rather than merged into another Account's map.
 */
export async function refreshWorkflowRunById(
    runId: string,
    options: Readonly<{
        signal?: AbortSignal;
        fence?: Readonly<{ isCurrent(): boolean }>;
    }> = {},
): Promise<void> {
    const isCurrent = (): boolean => options.fence?.isCurrent() ?? true;
    await materializeWorkflowRunAccountChange({
        runId,
        getRun: () => {
            const ids = Object.values(storage.getState().workflowRunInvocationsByRunId?.[runId]?.factsById ?? {})
                .filter(fact => fact.provenanceLoaded).map(fact => fact.id).sort();
            return ids.length ? getWorkflowRunSummary(runId, options.signal, ids) : getWorkflowRunSummary(runId, options.signal);
        },
        upsertRun: (detail) => {
            if (!isCurrent()) return;
            // The sparse sidecar semantics survive verbatim: `null` is a
            // readable Run whose accepted snapshot opened but carries no
            // authored title (Untitled), while `unavailable` is content this
            // host could not open. Collapsing the two locked a perfectly
            // readable unnamed Run behind "Content unavailable" in the
            // collection and in every Session card that reads the same row.
            storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(detail.run, detail.metadata)]);
            publishInvocationProvenance(detail.run, detail.invocationProvenance);
        },
        removeRun: (missingRunId) => {
            if (!isCurrent()) return;
            storage.getState().removeWorkflowRun(missingRunId);
        },
    });
}
