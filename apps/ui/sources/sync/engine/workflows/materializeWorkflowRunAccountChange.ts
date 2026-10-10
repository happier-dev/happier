import type { WorkflowRunPrivateMetadataV1, WorkflowRunSummaryV1, WorkflowRunListResultV1 } from '@happier-dev/protocol';

import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';

/**
 * Materialize one content-free `workflow-run:<id>` Account change.
 *
 * A successful lean exact-summary read replaces the shared row projection.
 * `run_not_found` is equally authoritative after history deletion, so it
 * removes the row. Any other failure is left rejected for the Account-change
 * applier to hold its durable cursor and retry instead of losing the
 * invalidation.
 *
 * The read is deliberately the lean summary projection — Run display fields
 * plus sparse private metadata — so background invalidation never pays the
 * history-proportional full-detail cost (invocation paging plus per-envelope
 * usage recomputation) that explicit Run detail keeps.
 */
export async function materializeWorkflowRunAccountChange(params: Readonly<{
    runId: string;
    getRun: () => Promise<Readonly<{
        run: WorkflowRunSummaryV1;
        metadata: WorkflowRunPrivateMetadataV1 | null;
        invocationProvenance?: WorkflowRunListResultV1['invocationProvenance'];
    }>>;
    upsertRun: (detail: Readonly<{
        run: WorkflowRunSummaryV1;
        metadata: WorkflowRunPrivateMetadataV1 | null;
        invocationProvenance?: WorkflowRunListResultV1['invocationProvenance'];
    }>) => void;
    removeRun: (runId: string) => void;
}>): Promise<void> {
    try {
        const detail = await params.getRun();
        params.upsertRun(detail);
    } catch (error) {
        if (error instanceof WorkflowActionError && error.code === 'run_not_found') {
            params.removeRun(params.runId);
            return;
        }
        throw error;
    }
}
