import { WorkflowRunIdV1Schema } from '@happier-dev/protocol/workflows/workflowIdsV1';

const WORKFLOW_QUESTION_PREFIX = 'workflow-run:';

/** Direct Start allocates a UUID; its post keeps an explicit Run reference across cold opens. */
export function buildDiscussionWorkflowQuestionLocalId(runId: string): string {
    return `${WORKFLOW_QUESTION_PREFIX}${runId}`;
}

/** Ordinary post retry ids, including UUIDs, carry no Run reference. */
export function readDiscussionWorkflowQuestionRunId(localId: string | null | undefined): string | null {
    if (!localId?.startsWith(WORKFLOW_QUESTION_PREFIX)) return null;
    const candidate = WorkflowRunIdV1Schema.safeParse(localId.slice(WORKFLOW_QUESTION_PREFIX.length));
    return candidate.success ? candidate.data : null;
}
