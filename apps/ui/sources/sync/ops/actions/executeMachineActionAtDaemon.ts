import { completeActionResult, settleActionOutput } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionIdSchema, isSessionSpawnNewActionIdV1, isWorkspaceSyncRelationshipWriteActionId, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec, hasDeclaredActionDaemonIngress } from '@happier-dev/protocol/actions/actionSpecs';
import { isDeploymentAccountMachineTransportActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { isPresentUserHostInvocation } from '@happier-dev/protocol/actions/invocationAuthority';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export const readUiAdmittedActionId = (actionId: string, input: unknown) =>
    actionId === 'approval.request.create' && input !== null && typeof input === 'object'
        && 'actionId' in input && typeof input.actionId === 'string' ? input.actionId : actionId;

/** The originating UI delegates these declarations to the receiving Machine. */
export function isUiMachineOwnedAdmissionAction(actionId: string, input: unknown): boolean {
    // Approval creation is account-owned. Its nested target is dispatched only
    // after the person decides; routing the request itself to the daemon loses
    // the account executor's machine-access capability and reports a false
    // target_unavailable even when the daemon is online.
    if (actionId === 'approval.request.create') return false;
    if (isWorkspaceSyncRelationshipWriteActionId(actionId)) return true;
    const parsed = ActionIdSchema.safeParse(readUiAdmittedActionId(actionId, input));
    if (!parsed.success) return false;
    if (isSessionSpawnNewActionIdV1(parsed.data)) return true;
    if (isDeploymentAccountMachineTransportActionIdV1(parsed.data)) return true;
    const spec = getActionSpec(parsed.data);
    return spec.executionPlacement === 'machine' && hasDeclaredActionDaemonIngress(spec, 'ui');
}

/** Runs the Machine-owned Action; a review digest means the person confirmed the review the Machine carried back. */
type ExecuteAction = (input: unknown, reviewDigest?: string) => Promise<unknown>;

type ConfirmPresentUserAction = NonNullable<ActionExecutorDeps['presentUserActionConfirmation']>;
const REVIEW_DIGEST = /^[A-Za-z0-9_-]{43}$/u;

/** The exact review a receiving executor carried back with its refusal, if it carried one. */
function readCarriedReview(result: Extract<ActionExecuteResult, { ok: false }>): Readonly<{ actionArgs: unknown; preview: unknown; reviewDigest: string }> | null {
    const details = result.details;
    if (!details || typeof details !== 'object') return null;
    const { review, reviewDigest } = details as { review?: unknown; reviewDigest?: unknown };
    const preview = review && typeof review === 'object' ? (review as { preview?: unknown }).preview : undefined;
    // The digest binds consequences the person must see: without the preview there is nothing to confirm (fail closed).
    if (typeof reviewDigest !== 'string' || !REVIEW_DIGEST.test(reviewDigest) || !preview || typeof preview !== 'object') return null;
    return { actionArgs: (review as { actionArgs?: unknown }).actionArgs, preview, reviewDigest };
}

/**
 * A receiving executor without a presenter (the daemon, an Environment's controller) refuses a present person's own
 * UI press before any effect and carries back the exact review its approval builder produced. The person's
 * executor owns the confirmation host (docs/actions.md): it presents that review and binds replay of the caller's
 * intent to its digest. Open replays the host-prepared destination. The receiving executor admits the confirmation
 * only while the reviewed consequences still hold. It never creates a self-approval request. A press that already carried a confirmation,
 * a refusal without a carried review, or any request that is not the person's own (Agent, Session, plugin, another
 * person) keeps the refusal and its own approval path.
 */
export async function confirmOwnUiRefusal(actionId: ActionId, input: unknown, context: ActionExecutorContext,
    result: ActionExecuteResult, confirm: ConfirmPresentUserAction | undefined,
    executeConfirmed: (confirmedInput: unknown, reviewDigest: string) => Promise<ActionExecuteResult>): Promise<ActionExecuteResult> {
    if (result.ok || result.errorCode !== 'action_interactive_review_required' || !confirm || context.surface !== 'ui'
        || context.interactivePresentation === 'unavailable' || !isPresentUserHostInvocation(context)
        || context.presentUserConfirmation) return result;
    const review = readCarriedReview(result);
    if (!review) return result;
    const spec = getActionSpec(actionId);
    // Live-only custody keeps execution inputs on this invocation and gives the presenter the carried projection.
    // Ordinary replay preserves intent so the receiver can rebuild its review. Open's native owner requires the prepared destination.
    const liveOnly = spec.approvalInputCustody === 'live_only';
    const parsed = spec.inputSchema.safeParse(!liveOnly && actionId === 'projects.open' ? review.actionArgs : input);
    if (!parsed.success) return result;
    const confirmed = await confirm({ actionId, input: liveOnly ? review.actionArgs : parsed.data, context, preview: review.preview });
    if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled', effectAttempted: false };
    if (!confirmed) return { ok: false, errorCode: 'approval_canceled', error: 'approval_canceled', effectAttempted: false };
    const executed = await executeConfirmed(parsed.data, review.reviewDigest);
    // A first confirmation may precede native destination preparation. Present a
    // changed destination through this same surface; an unchanged refusal stays refused.
    if (actionId === 'projects.open' && !executed.ok && executed.errorCode === 'action_interactive_review_required') {
        const next = readCarriedReview(executed);
        if (next && !sameStrictJsonValue(next.actionArgs, parsed.data)) {
            return confirmOwnUiRefusal(actionId, parsed.data, context, executed, confirm, executeConfirmed);
        }
    }
    return executed;
}

/** The daemon admits the Action; the originating UI presents the review it carries back when it cannot present it. */
export async function executeMachineActionAtDaemon(
    actionId: ActionId,
    input: unknown,
    context: ActionExecutorContext,
    execute: ExecuteAction,
    confirm?: ConfirmPresentUserAction,
): Promise<ActionExecuteResult> {
    if (context.externalActionCredential || context.externalActionExecutionAuthorization || context.rpcSessionAuthorization) {
        return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    }
    const spec = getActionSpec(actionId);
    const parsed = spec.inputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const settle = (result: ActionExecuteResult) => result.ok ? settleActionOutput(actionId, result) : result;
    const result = completeActionResult(await execute(parsed.data));
    return result.ok ? settle(result) : confirmOwnUiRefusal(actionId, parsed.data, context, result, confirm,
        async (confirmedInput, reviewDigest) => settle(completeActionResult(await execute(confirmedInput, reviewDigest))));
}
