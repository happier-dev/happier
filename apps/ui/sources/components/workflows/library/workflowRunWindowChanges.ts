import { getStorage } from '@/sync/domains/state/storage';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { isTriggeredWorkflowRun } from '@/components/sessions/work/workflowRunTriggerScope';
import { buildWorkflowRunListFilter, listWorkflowRuns } from '@/sync/domains/workflows/workflowRunListActions';
import type { WorkflowRunListInvalidation } from '@/sync/domains/workflows/workflowRunListInvalidation';
import { isBeyondWorkflowRunListSpan, workflowRunListWindowStoreKey, workflowRunRowFromSummary, workflowRunStoreKey,
    type WorkflowRunListWindowId } from '@/sync/store/domains/workflowRuns';

/** Work membership requires the immutable trigger scope carried by the Session list answer. */
export function assertWorkflowRunWindowScope(windowId: WorkflowRunListWindowId, runs: readonly WorkflowRunSummaryV1[]): void {
    if ((windowId.startsWith('session-origin:') || windowId.startsWith('session-destination:'))
        && runs.some(run => isTriggeredWorkflowRun(run) && run.automationScopeSessionId === undefined)) {
        throw new Error('workflow_run_scope_unavailable');
    }
}

/** Refresh changed rows through the same server filter that owns this window's membership. */
export async function refreshWorkflowRunWindowChanges(
    windowId: Exclude<WorkflowRunListWindowId, 'automationAttention'>,
    change: WorkflowRunListInvalidation,
    lifetime: ServerAccountScopeLifetime,
    signal: AbortSignal,
    projection?: 'membership',
): Promise<'current' | 'unchanged' | 'changed'> {
    const storeId = workflowRunListWindowStoreKey(windowId, lifetime.scope);
    const before = getStorage().getState();
    const window = before.workflowRunListWindows[storeId];
    if (!window) return 'changed';
    const sources = change.sourceArtifactIds;
    const filter = buildWorkflowRunListFilter(windowId);
    // A materialized origin is the same immutable relation used by the server query.
    // Unrelated Session pushes need neither a membership request nor a window publication.
    if (change.summaryCurrent && !sources?.length && change.runIds?.length) {
        const current = change.runIds.every(id => {
            const summary = before.workflowRunsById[workflowRunStoreKey(id, lifetime.scope)]?.summary;
            if (!summary) return false;
            if (filter.originSessionId !== undefined && summary.origin.originSessionId !== filter.originSessionId) return true;
            return window.runIds.includes(id) && (filter.originSessionId !== undefined
                || Object.keys(filter).every(key => key === 'runIds' || key === 'targetSessionId'));
        });
        if (current) return 'current';
    }
    const selectedIds = new Set(change.runIds);
    // A wake covering an exact selection is already the whole window read.
    if (!sources?.length && filter.runIds?.every(id => selectedIds.has(id))) return 'changed';
    const previousIds = new Set(window.runIds.filter(id => selectedIds.has(id)
        || sources?.includes(window.sourceArtifactIdsByRunId?.[id] ?? '')));
    const currentIds = new Set<string>();
    const selections = [
        ...(change.runIds?.length ? [{ runIds: change.runIds }] : []),
        // The source query discovers newly visible Runs; exact windows retain
        // their own Run selection through the base filter above.
        ...(sources?.map(sourceArtifactId => ({ sourceArtifactId })) ?? []),
    ];
    for (const selection of selections) {
        let cursor: string | undefined;
        do {
            const page = await listWorkflowRuns({ filter: { ...filter, ...selection }, cursor,
                // Keep the window's admitted projection: membership is attention-only,
                // not a generic lean read for an already-materialized summary.
                projection, signal, accountLifetime: lifetime });
            if (!lifetime.isCurrent() || signal.aborted) return 'current';
            assertWorkflowRunWindowScope(windowId, page.runs);
            const rows = page.runs.map(run => workflowRunRowFromSummary(run, page.metadataByRunId[run.id] ?? null,
                page.supportsAnotherRoundByRunId?.[run.id], page.callerAccessByRunId?.[run.id]));
            if (!change.summaryCurrent && projection === undefined) getStorage().getState().upsertWorkflowRuns(rows, lifetime.scope);
            for (const row of rows) {
                if (previousIds.has(row.id) || !window.nextCursor || !window.frontier || !isBeyondWorkflowRunListSpan(row, window.frontier)) currentIds.add(row.id);
            }
            cursor = page.nextCursor;
        } while (cursor);
    }
    return previousIds.size !== currentIds.size || [...previousIds].some(id => !currentIds.has(id)) ? 'changed' : 'unchanged';
}
