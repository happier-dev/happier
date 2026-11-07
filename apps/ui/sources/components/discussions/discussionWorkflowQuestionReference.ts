const WORKFLOW_QUESTION_PREFIX = 'workflow-run:';

/** Start and reconciliation share one ordinary-post mutation identity. */
export function buildDiscussionWorkflowQuestionLocalId(runId: string): string {
    return `${WORKFLOW_QUESTION_PREFIX}${runId}`;
}
