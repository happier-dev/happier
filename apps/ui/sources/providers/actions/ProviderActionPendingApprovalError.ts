import type { z } from 'zod/mini';
import type { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

/** A queued approval is neither a transport failure nor a completed Provider mutation. */
export class ProviderActionPendingApprovalError extends Error {
    readonly code = 'approval_request_created';
    constructor(readonly approval: z.output<typeof ActionApprovalRequestCreatedResultSchema>) {
        super('approval_request_created');
    }
}
