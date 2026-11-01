import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { isPresentUserHostInvocation } from '@happier-dev/protocol/actions/invocationAuthority';

/** Called only by the designed Confirm dispatch, after its Account and target are captured. */
export function bindPresentUserActionConfirmation(actionId: ActionId, input: unknown, context: ActionExecutorContext): ActionExecutorContext {
  // A supplied marker belongs to its original invocation, including legacy default-only markers.
  if (context.presentUserConfirmation || !isPresentUserHostInvocation(context)
    || !context.runtimeAccountId || !context.actionRequestId || !(context.serverIdentityId ?? context.serverId)) return context;
  const target = context.externalActionTarget;
  return { ...context, authority: 'present_user', actionCaller: { kind: 'host' }, presentUserConfirmation: {
    actionId, inputDigest: computeActionInputApprovalDigestV1(actionId, input, context.sessionTargetsV1), requestId: context.actionRequestId,
    accountId: context.runtimeAccountId, serverId: context.serverIdentityId ?? context.serverId!,
    target: target ? target.kind === 'session' ? { kind: 'session', sessionId: target.sessionId }
      : { kind: 'machine', machineId: target.machineId, ...(target.project ? { project: { ...target.project } } : {}) } : null,
  } };
}
