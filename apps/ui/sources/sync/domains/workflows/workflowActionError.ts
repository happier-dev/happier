import {
    WORKFLOW_OPERATION_ERROR_CODES_V1,
    type WorkflowOperationErrorCodeV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { WorkflowActionFailureV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

/**
 * An owner-reported failure from the shared Action front door.
 *
 * One owner for every workflow Action caller — definitions, Run now, the Run
 * list and Run detail — so a surface can branch on `run_access_denied` or
 * `currentness_conflict` without matching prose, and so there is a single place
 * that decides what counts as a workflow error code.
 *
 * The shared Action front door also carries plugin and policy failures.
 * `code` preserves the owner's code; workflow presentation narrows it through
 * isWorkflowOperationErrorCode without inventing a workflow meaning.
 */
export class WorkflowActionError extends Error {
    readonly code: string | null;
    readonly rawCode: string | null;
    readonly failure: WorkflowActionFailureV1 | null;
    readonly requestId: string | undefined;
    readonly approval: ActionApprovalRequestCreatedResult | undefined;
    /** The owner's opaque failure details, for callers that read a code's documented details (an options dependency). */
    readonly rawDetails: unknown;

    constructor(params: Readonly<{ message: string; rawCode: string | null; failure?: WorkflowActionFailureV1; rawDetails?: unknown; requestId?: string; approval?: ActionApprovalRequestCreatedResult }>) {
        // The Workflow presenter supplies the copy for closed Workflow codes.
        super(isWorkflowOperationErrorCode(params.rawCode) ? params.rawCode : params.message);
        this.name = 'WorkflowActionError';
        this.rawCode = params.rawCode;
        this.failure = params.failure ?? null;
        this.requestId = params.requestId;
        this.approval = params.approval;
        this.rawDetails = params.rawDetails;
        this.code = params.rawCode;
    }
}

export function isWorkflowOperationErrorCode(
    value: string | null,
): value is WorkflowOperationErrorCodeV1 {
    return value !== null && (WORKFLOW_OPERATION_ERROR_CODES_V1 as readonly string[]).includes(value);
}
