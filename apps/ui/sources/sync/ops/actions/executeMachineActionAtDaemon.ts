import { completeActionResult, settleActionOutput } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { isPresentUserHostInvocation } from '@happier-dev/protocol/actions/invocationAuthority';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';

type ExecuteAction = (actionId: ActionId, input: unknown) => Promise<unknown>;
type ExecuteCompletedAction = (actionId: ActionId, input: unknown) => Promise<ActionExecuteResult>;

/**
 * A receiving executor without a presenter (the daemon or an Environment's controller) refuses a
 * present-user review before any effect. The originating UI turns that refusal into its existing
 * approval review of the exact refused input, so the person reviews it and nothing runs without it.
 */
export async function openPresentUserReviewForRefusal(actionId: ActionId, input: unknown,
    context: ActionExecutorContext, result: ActionExecuteResult, execute: ExecuteCompletedAction): Promise<ActionExecuteResult> {
    if (result.ok || result.errorCode !== 'action_interactive_review_required' || context.surface !== 'ui'
        || context.interactivePresentation === 'unavailable' || !isPresentUserHostInvocation(context)) return result;
    const parsed = getActionSpec(actionId).inputSchema.safeParse(input);
    if (!parsed.success) return result;
    const review = await execute('approval.request.create', {
        actionId, actionArgs: parsed.data, summary: getActionSpec(actionId).title, createdBy: { surface: 'system' },
    });
    if (!review.ok) return review;
    const artifactId = typeof review.result === 'object' && review.result !== null && 'artifactId' in review.result
        ? readNonBlankOpaqueIdentifier(review.result.artifactId) : null;
    if (!artifactId) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    return settleActionOutput(actionId, { ok: true, result: { kind: 'approval_request_created', actionId, artifactId } });
}

/** The daemon admits the Action; the originating UI opens its existing approval review. */
export async function executeMachineActionAtDaemon(
    actionId: ActionId,
    input: unknown,
    context: ActionExecutorContext,
    execute: ExecuteAction,
): Promise<ActionExecuteResult> {
    if (context.externalActionCredential || context.externalActionExecutionAuthorization || context.rpcSessionAuthorization) {
        return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    }
    const spec = getActionSpec(actionId);
    const parsed = spec.inputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const result = completeActionResult(await execute(actionId, parsed.data));
    return result.ok ? settleActionOutput(actionId, result)
        : openPresentUserReviewForRefusal(actionId, parsed.data, context, result,
            async (requestedActionId, actionInput) => completeActionResult(await execute(requestedActionId, actionInput)));
}
