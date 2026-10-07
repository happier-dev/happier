import {
    WORKFLOW_OPERATION_ERROR_CODES_V1,
    type WorkflowOperationErrorCodeV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowActionFailureV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

/**
 * A workflow operation that failed at its canonical owner.
 *
 * One owner for every workflow Action caller — definitions, Run now, the Run
 * list and Run detail — so a surface can branch on `run_access_denied` or
 * `currentness_conflict` without matching prose, and so there is a single place
 * that decides what counts as a workflow error code.
 *
 * `code` is the closed Protocol vocabulary when the owner returned one. An
 * unrecognized transport failure keeps `code: null` and preserves the original
 * string in `rawCode`, rather than being coerced into a workflow code the owner
 * never reported.
 */
export class WorkflowActionError extends Error {
    readonly code: WorkflowOperationErrorCodeV1 | null;
    readonly rawCode: string | null;
    readonly failure: WorkflowActionFailureV1 | null;

    constructor(params: Readonly<{ message: string; rawCode: string | null; failure?: WorkflowActionFailureV1 }>) {
        super(params.message);
        this.name = 'WorkflowActionError';
        this.rawCode = params.rawCode;
        this.failure = params.failure ?? null;
        this.code = isWorkflowOperationErrorCode(params.rawCode) ? params.rawCode : null;
    }
}

export function isWorkflowOperationErrorCode(
    value: string | null,
): value is WorkflowOperationErrorCodeV1 {
    return value !== null && (WORKFLOW_OPERATION_ERROR_CODES_V1 as readonly string[]).includes(value);
}
