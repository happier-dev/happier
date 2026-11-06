import { getStorage } from '@/sync/domains/state/storage';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { buildWorkflowRunListFilter, listWorkflowRuns } from '@/sync/domains/workflows/workflowRunListActions';
import type { WorkflowRunListInvalidation } from '@/sync/domains/workflows/workflowRunListInvalidation';
import { isBeyondWorkflowRunListSpan, workflowRunListWindowStoreKey, workflowRunRowFromSummary,
    type WorkflowRunListWindowId } from '@/sync/store/domains/workflowRuns';

/** Refresh changed rows through the same server filter that owns this window's membership. */
export async function refreshWorkflowRunWindowChanges(
    windowId: Exclude<WorkflowRunListWindowId, 'automationAttention'>,
    change: WorkflowRunListInvalidation,
    lifetime: ServerAccountScopeLifetime,
    signal: AbortSignal,
    projection?: 'membership',
): Promise<boolean> {
    const storeId = workflowRunListWindowStoreKey(windowId, lifetime.scope);
    const before = getStorage().getState();
    const window = before.workflowRunListWindows[storeId];
    if (!window) return true;
    const sources = change.sourceArtifactIds;
    const selectedIds = new Set(change.runIds);
    const previousIds = new Set(window.runIds.filter(id => selectedIds.has(id)
        || sources?.includes(window.sourceArtifactIdsByRunId?.[id] ?? '')));
    const currentIds = new Set<string>();
    const filter = buildWorkflowRunListFilter(windowId);
    // The push producer has already read these rows. Existing members of an
    // unfiltered/exact window cannot change membership without being removed.
    if (change.summaryCurrent && !sources?.length && change.runIds?.every(id => window.runIds.includes(id))
        && Object.keys(filter).every(key => key === 'runIds')) return false;
    const selections = [
        ...(change.runIds?.length ? [{ runIds: change.runIds }] : []),
        ...(sources?.map(sourceArtifactId => ({ sourceArtifactId,
            runIds: window.runIds.filter(id => window.sourceArtifactIdsByRunId?.[id] === sourceArtifactId) })) ?? []),
    ];
    for (const selection of selections) {
        let cursor: string | undefined;
        do {
            const page = await listWorkflowRuns({ filter: { ...filter, ...selection }, cursor,
                projection: change.summaryCurrent ? 'membership' : projection, signal, accountLifetime: lifetime });
            if (!lifetime.isCurrent() || signal.aborted) return false;
            const rows = page.runs.map(run => workflowRunRowFromSummary(run, page.metadataByRunId[run.id] ?? null,
                page.supportsAnotherRoundByRunId?.[run.id], page.callerAccessByRunId?.[run.id]));
            if (!change.summaryCurrent && projection === undefined) getStorage().getState().upsertWorkflowRuns(rows, lifetime.scope);
            for (const row of rows) {
                if (previousIds.has(row.id) || !window.nextCursor || !window.frontier || !isBeyondWorkflowRunListSpan(row, window.frontier)) currentIds.add(row.id);
            }
            cursor = page.nextCursor;
        } while (cursor);
    }
    return previousIds.size !== currentIds.size || [...previousIds].some(id => !currentIds.has(id));
}
