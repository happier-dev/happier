import { storage } from '@/sync/domains/state/storage';
import { listWorkflowRuns } from '@/sync/domains/workflows/workflowRunListActions';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import type { WorkflowRunGetResultV1, WorkflowRunListResultV1 } from '@happier-dev/protocol/workflows/actionsV1';

import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { supportsWorkflowAnotherRoundV1 } from '@happier-dev/protocol/workflows';
import { readWorkflowRunDisplayMetadataV1 } from '@happier-dev/protocol/workflows/workflowRunDisplayMetadataV1';

/** Opened detail uses the same Account body owner as the exact Run screen. Callers fence the read before publication. */
export function publishOpenedWorkflowRunDetail(detail: WorkflowRunGetResultV1, scope?: ServerAccountScope | null): void {
    const metadata = readWorkflowRunDisplayMetadataV1(detail.acceptedContext, () => detail.authoredDefinition);
    storage.getState().upsertWorkflowRuns([{ ...workflowRunRowFromSummary(detail.run,
        metadata ? { kind: 'available', value: metadata } : null,
        supportsWorkflowAnotherRoundV1(detail.definition), detail.callerAccess), detail }], scope);
}

// Only pending reads are shared; the Account's existing Run/fact maps own all resolved content.
const pendingSummaries = new WeakMap<ActiveServerAccountScopeLifetime, Map<string, Promise<void>>>();

function publishInvocationProvenance(run: WorkflowRunListResultV1['runs'][number], facts: WorkflowRunListResultV1['invocationProvenance'], scope?: ServerAccountScope): void {
    for (const fact of facts ?? []) {
        if (fact.index.runId !== run.id) continue;
        storage.getState().upsertWorkflowRunInvocation({ runId: run.id, scope, parentRevision: run.revision,
            invocation: { ...fact.index, ...(fact.stepOrdinal ? { stepOrdinal: fact.stepOrdinal } : {}),
                ...(fact.notificationCondition ? { notificationCondition: fact.notificationCondition } : {}), provenanceLoaded: true } });
    }
}

/** Batched lean Run names/facts; transcript callers may also request exact invocation provenance. */
export function refreshWorkflowRunSummaries(
    references: readonly Readonly<{ runId: string; invocationRecordIds?: readonly string[] }>[],
): Promise<void> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || references.length === 0) return Promise.resolve();
    const normalized = references.map(ref => ({ ...ref, invocationRecordIds: ref.invocationRecordIds ?? [] }));
    const key = JSON.stringify(normalized);
    let pending = pendingSummaries.get(lifetime);
    if (!pending) { pending = new Map(); pendingSummaries.set(lifetime, pending); }
    const known = pending.get(key);
    if (known) return known;
    const abort = new AbortController();
    const retirement = lifetime.onRetire(() => abort.abort());
    const read = (async () => {
        let cursor: string | undefined;
        do {
            const page = await listWorkflowRuns({ filter: { runIds: normalized.map(ref => ref.runId),
                invocationProvenance: normalized.filter(ref => ref.invocationRecordIds.length > 0) },
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
 * Refresh exact Runs into the Account-scoped `workflowRunsById` owner.
 *
 * This is the single composition of the lean exact-Run summary read, the
 * canonical change materialization and the shared row merge. The Account-change
 * applier invokes it once with every `workflow-run:<id>` of a changes page (a
 * read per Run multiplies Account currentness and storage traffic by the page's
 * Run count); a transcript row that has just observed a start acknowledgement
 * invokes it for that one Run so the row is known before the change stream
 * mentions it. Neither keeps a copy: the shared row is the only body, and its
 * revision merge makes a delayed read harmless.
 *
 * The read is the list owner's exact-Run projection — Run summaries plus their
 * sparse private metadata — never the full `workflow.run.get` detail. Full
 * detail pages all invocations and opens every progress envelope to recompute
 * usage, a history-proportional cost no background invalidation or transcript
 * placeholder may pay. Explicit Run detail keeps that read.
 *
 * A Run the Home no longer lists is authoritatively deleted, so its row is
 * removed. Any failure rejects with the rows untouched, so the caller holds its
 * durable cursor and retries instead of losing the invalidation.
 *
 * `fence` is the caller's Account lifetime. A read that completes after that
 * lifetime retired is discarded rather than merged into another Account's map.
 */
export async function refreshWorkflowRunsByIds(
    runIds: readonly string[],
    options: Readonly<{
        signal?: AbortSignal;
        fence?: Readonly<{ isCurrent(): boolean }>;
        accountLifetime?: ServerAccountScopeLifetime;
    }> = {},
): Promise<void> {
    const ids = [...new Set(runIds)];
    if (ids.length === 0) return;
    const scope = options.accountLifetime?.scope;
    const isCurrent = (): boolean => options.fence?.isCurrent() ?? true;
    const invocationProvenance = ids.flatMap(runId => {
        const invocationRecordIds = Object.values(storage.getState().workflowRunInvocationsByRunId?.[workflowRunStoreKey(runId, scope)]?.factsById ?? {})
            .filter(fact => fact.provenanceLoaded).map(fact => fact.id).sort();
        return invocationRecordIds.length > 0 ? [{ runId, invocationRecordIds }] : [];
    });
    const listed: WorkflowRunListResultV1['runs'] = [];
    const metadataByRunId: WorkflowRunListResultV1['metadataByRunId'] = {};
    const provenance: NonNullable<WorkflowRunListResultV1['invocationProvenance']> = [];
    let cursor: string | undefined;
    do {
        const page = await listWorkflowRuns({ filter: { runIds: ids, invocationProvenance },
            ...(cursor ? { cursor } : {}), ...(options.signal ? { signal: options.signal } : {}),
            ...(options.accountLifetime ? { accountLifetime: options.accountLifetime } : {}) });
        listed.push(...page.runs);
        Object.assign(metadataByRunId, page.metadataByRunId);
        provenance.push(...(page.invocationProvenance ?? []));
        cursor = page.nextCursor;
    } while (cursor);
    if (!isCurrent()) return;
    // The sparse sidecar semantics survive verbatim: `null` is a readable Run
    // whose accepted snapshot opened but carries no authored title (Untitled),
    // while `unavailable` is content this host could not open. Collapsing the
    // two locked a perfectly readable unnamed Run behind "Content unavailable"
    // in the collection and in every Session card that reads the same row.
    const state = storage.getState();
    state.upsertWorkflowRuns(listed.map(run => workflowRunRowFromSummary(run, metadataByRunId[run.id] ?? null)), scope);
    for (const run of listed) publishInvocationProvenance(run, provenance, scope);
    const listedIds = new Set(listed.map(run => run.id));
    for (const runId of ids) if (!listedIds.has(runId)) state.removeWorkflowRun(runId, scope);
}

/** One exact Run: the batched owner with a single id. */
export function refreshWorkflowRunById(
    runId: string,
    options: Parameters<typeof refreshWorkflowRunsByIds>[1] = {},
): Promise<void> {
    return refreshWorkflowRunsByIds([runId], options);
}
