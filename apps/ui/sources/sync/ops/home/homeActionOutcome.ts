import {
    ActionApprovalRequestCreatedResultSchema,
    type ActionExecuteResult,
} from '@happier-dev/protocol/actions/actionExecutionResult';

import { homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';

/**
 * The lifecycle result shared by every exact-Home Action client.
 *
 * Domain clients must classify this envelope before parsing their own output:
 * an approval request means the Home mutation has not run yet.
 */
export type HomeActionOutcome =
    | Readonly<{ kind: 'completed'; result: unknown }>
    | Readonly<{ kind: 'approval_pending'; artifactId: string }>
    | Readonly<{ kind: 'failed'; failure: HomeDomainFailure }>;

export function classifyHomeActionOutcome(result: ActionExecuteResult): HomeActionOutcome {
    if (!result.ok) {
        return Object.freeze({
            kind: 'failed' as const,
            failure: homeDomainFailureFromActionFailure(result),
        });
    }
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) {
        return Object.freeze({
            kind: 'approval_pending' as const,
            artifactId: approval.data.artifactId,
        });
    }
    return Object.freeze({ kind: 'completed' as const, result: result.result });
}
