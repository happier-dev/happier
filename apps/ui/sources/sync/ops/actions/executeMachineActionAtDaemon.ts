import { completeActionResult, settleActionOutput } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { isPresentUserHostInvocation } from '@happier-dev/protocol/actions/invocationAuthority';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';

/** The daemon admits the Action; the originating UI opens its existing approval review. */
export async function executeMachineActionAtDaemon(
    actionId: ActionId,
    input: unknown,
    context: ActionExecutorContext,
    execute: (actionId: ActionId, input: unknown) => Promise<unknown>,
): Promise<ActionExecuteResult> {
    if (context.externalActionCredential || context.externalActionExecutionAuthorization || context.rpcSessionAuthorization) {
        return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    }
    const spec = getActionSpec(actionId);
    const parsed = spec.inputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const result = completeActionResult(await execute(actionId, parsed.data));
    if (!result.ok && result.errorCode === 'action_interactive_review_required'
        && context.surface === 'ui' && isPresentUserHostInvocation(context)) {
        const review = completeActionResult(await execute('approval.request.create', {
            actionId, actionArgs: parsed.data, summary: spec.title, createdBy: { surface: 'system' },
        }));
        if (!review.ok) return review;
        const artifactId = typeof review.result === 'object' && review.result !== null && 'artifactId' in review.result
            ? readNonBlankOpaqueIdentifier(review.result.artifactId) : null;
        if (!artifactId) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
        return settleActionOutput(actionId, { ok: true, result: { kind: 'approval_request_created', actionId, artifactId } });
    }
    return settleActionOutput(actionId, result);
}
