import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { WorkflowInvocationListResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { storage } from '@/sync/domains/state/storageStore';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';

import { createWorkflowRunDetailActions } from './workflowRunDetailActions';

/** Retained facts own the revision frontier; requests keep no second cache. */
export async function refreshWorkflowRunInvocationHistory(input: Readonly<{
    runId: string;
    accountLifetime: ServerAccountScopeLifetime;
    signal: AbortSignal;
    includeContent?: true;
}>): Promise<void> {
    const { runId, accountLifetime, signal } = input;
    const known = storage.getState().workflowRunInvocationsByRunId[workflowRunStoreKey(runId, accountLifetime.scope)];
    const knownContentRevisions = Object.fromEntries((known?.history.invocationIds ?? []).flatMap((id): [string, string][] => {
        const fact = known?.factsById[id];
        return !fact || input.includeContent && fact.opened?.index.contentRevision !== fact.contentRevision ? [] : [[fact.id, fact.contentRevision]];
    }));
    const actions = createWorkflowRunDetailActions({ accountLifetime });
    const invocations: WorkflowInvocationListResultV1['invocations'] = [];
    const invocationDetails: NonNullable<WorkflowInvocationListResultV1['invocationDetails']> = [];
    let parentRevision = 0;
    let cursor: string | undefined;
    do {
        // Keep this snapshot fixed through continuation pages: their cursors
        // bind the complete selection, including these already-held revisions.
        const page = await actions.listInvocations({ runId, knownContentRevisions,
            ...(input.includeContent ? { includeContent: true } : {}), ...(cursor === undefined ? {} : { cursor }) }, signal);
        if (signal.aborted || !accountLifetime.isCurrent()) return;
        invocations.push(...page.invocations);
        invocationDetails.push(...(page.invocationDetails ?? []));
        parentRevision = Math.max(parentRevision, page.parentRevision);
        cursor = page.nextCursor;
    } while (cursor !== undefined);
    // A delta cursor binds its revision snapshot, so it cannot become the
    // ordinary history window's continuation. Publish the completed span once.
    storage.getState().applyWorkflowRunInvocationPage({ scope: accountLifetime.scope, runId,
        invocations, invocationDetails, nextCursor: null, parentRevision, mode: 'delta' });
}

/** Open exactly the demanded historical attempt; recovery remains an explicit detail read. */
export async function readWorkflowRunInvocationProgress(input: Readonly<{
    runId: string;
    invocationId: string;
    accountLifetime: ServerAccountScopeLifetime;
    signal: AbortSignal;
}>): Promise<void> {
    const { accountLifetime, signal, runId, invocationId } = input;
    const page = await createWorkflowRunDetailActions({ accountLifetime }).listInvocations({ runId, invocationId, includeContent: true }, signal);
    if (signal.aborted || !accountLifetime.isCurrent()) return;
    for (const opened of page.invocationDetails ?? []) {
        storage.getState().upsertWorkflowRunInvocation({ scope: accountLifetime.scope, runId,
            invocation: { ...opened.index, opened }, parentRevision: page.parentRevision });
    }
}
