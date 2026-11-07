import {
    ActionApprovalRequestCreatedResultSchema,
    type ActionExecuteResult,
} from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

import { homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    createActionApprovalContinuation,
    type ActionApprovalContinuation,
} from '@/components/approvals/actionApprovalContinuation';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

/**
 * The lifecycle result shared by every exact-Home Action client.
 *
 * Domain clients must classify this envelope before parsing their own output:
 * an approval request means the Home mutation has not run yet.
 */
export type HomeActionOutcome =
    | Readonly<{ kind: 'completed'; result: unknown }>
    | Readonly<{ kind: 'approval_pending'; artifactId: string }>
    | Readonly<{ kind: 'failed'; failure: HomeDomainFailure<string> }>;

export type HomeActionFailure = Extract<HomeActionOutcome, { kind: 'failed' }>['failure'];

export function classifyHomeActionOutcome(result: ActionExecuteResult, actionId?: ActionId): HomeActionOutcome {
    if (!result.ok) {
        return Object.freeze({
            kind: 'failed' as const,
            failure: homeDomainFailureFromActionFailure(result, actionId),
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

/** Domain callers keep their result decoder; this owner binds pending results to their invocation. */
export function observeHomeActionOutcome<TValue, TActionId extends ActionId>(input: Readonly<{
    result: ActionExecuteResult;
    actionId: TActionId;
    actionInput: unknown;
    scope: ServerAccountScope;
    signal?: AbortSignal;
    onSucceeded: (value: TValue) => void | Promise<void>;
    onFailed?: (code: string, failure?: ActionExecuteFailure) => void;
}>): Exclude<HomeActionOutcome, { kind: 'approval_pending' }>
    | Readonly<{ kind: 'approval_pending'; approval: ActionApprovalContinuation }> {
    const outcome = classifyHomeActionOutcome(input.result, input.actionId);
    if (outcome.kind !== 'approval_pending') return outcome;
    return { kind: 'approval_pending', approval: createActionApprovalContinuation<TValue, TActionId>({
        artifactId: outcome.artifactId, actionId: input.actionId, scope: input.scope,
        expectedInput: input.actionInput, ...(input.signal ? { signal: input.signal } : {}),
        onSucceeded: input.onSucceeded, onFailed: input.onFailed,
    }) };
}
