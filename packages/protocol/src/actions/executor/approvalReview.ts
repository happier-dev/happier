import { readRecord } from '../../inputs/inputRecords.js';
import { computeActionInputApprovalDigestV1 } from '../decisionAuthority.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { ACTION_INVOKE_ACTION_ID_V1, type ActionId } from '../actionIds.js';
import type { ActionExecutorContext } from './types.js';
import { isPresentUserHostInvocation, isHomeAdmittedPresentUserHostInvocation, isPluginActionInvokeConfirmationV1 } from '../invocationAuthority.js';

/** Both a witnessed Artifact decision and a native Confirm record the same reviewed parent. */
export function recordPresentUserApprovalV1(args: Readonly<{
  actionId: ActionId;
  input: unknown;
  requestId: string;
  artifactId?: string;
  requestSurface?: ActionExecutorContext['surface'];
  decidingAccountId?: string;
  decidedAtMs?: number;
}>): NonNullable<ActionExecutorContext['presentUserApproval']> {
  return {
    ...(args.artifactId ? { artifactId: args.artifactId } : {}),
    actionId: args.actionId, requestId: args.requestId,
    inputDigest: computeActionInputApprovalDigestV1(args.actionId, args.input),
    ...(args.requestSurface ? { requestSurface: args.requestSurface } : {}),
    ...(args.decidingAccountId ? { decidingAccountId: args.decidingAccountId } : {}),
    ...(args.decidedAtMs === undefined ? {} : { decidedAtMs: args.decidedAtMs }),
  };
}

// Confirmation belongs to one invocation. Weak membership retains no completed operation or timer.
const consumedConfirmations = new WeakSet<object>();

function matchesConfirmation(actionId: ActionId, input: unknown, context: ActionExecutorContext,
  inputDigest?: string): boolean {
  const confirmation = context.presentUserConfirmation;
  const binding = context.externalActionExecutionAuthorization?.binding;
  return Boolean(confirmation && !consumedConfirmations.has(confirmation) && confirmation.actionId === actionId
    && !context.externalActionCredential && !context.rpcSessionAuthorization
    && (!binding || 'authentication' in binding && (binding.authentication.kind === 'account'
        || binding.authentication.kind === 'terminal' && context.surface === 'cli')
      && !binding.sessionActionOrigin && !binding.workflowActionOrigin
      && binding.accountId === context.runtimeAccountId && binding.requestId === context.actionRequestId
      && binding.actionId === actionId && sameStrictJsonValue(binding.target, context.externalActionTarget))
    && context.runtimeAccountId && context.actionRequestId
    && confirmation.accountId === context.runtimeAccountId && confirmation.requestId === context.actionRequestId
    && confirmation.serverId === (context.serverIdentityId ?? context.serverId)
    && sameStrictJsonValue(confirmation.target ?? null, context.externalActionTarget ?? null)
    && confirmation.inputDigest === (inputDigest ?? computeActionInputApprovalDigestV1(actionId, input, context.sessionTargetsV1)));
}

/** Consume the host's completed confirmation for this exact normalized invocation. */
export function admitPresentUserConfirmationV1(actionId: ActionId, input: unknown,
  context: ActionExecutorContext): NonNullable<ActionExecutorContext['presentUserApproval']> | null {
  if (!isPresentUserHostInvocation({ ...context, externalActionExecutionAuthorization: undefined })
    || context.actionCaller?.kind !== 'host' || !matchesConfirmation(actionId, input, context)) return null;
  consumedConfirmations.add(context.presentUserConfirmation!);
  return recordPresentUserApprovalV1({ actionId, input, requestId: context.actionRequestId!,
    requestSurface: context.surface, decidingAccountId: context.runtimeAccountId, decidedAtMs: Date.now() });
}

/** The target gate consumes only this Account relay's exact already-confirmed wrapper. */
export function admitAccountActionInvokeConfirmationV1(input: unknown, context: ActionExecutorContext,
  pluginInputDigest: string | null): boolean {
  const binding = context.externalActionExecutionAuthorization?.binding;
  if (!binding || !('authentication' in binding) || binding.authentication.kind !== 'account'
    || binding.sessionActionOrigin || binding.sessionActionSource || binding.workflowActionOrigin
    || binding.serverIdentityId !== (context.serverIdentityId ?? context.serverId)) return false;
  if (pluginInputDigest && isPluginActionInvokeConfirmationV1(context)
    && matchesConfirmation(ACTION_INVOKE_ACTION_ID_V1, input, context, pluginInputDigest)) {
    consumedConfirmations.add(context.presentUserConfirmation!);
    return true;
  }
  // The generic host Action executor already consumed and admitted its private proof.
  const review = context.presentUserApproval;
  if (typeof readRecord(input).expectedContributorOccurrenceId !== 'string'
    || !isHomeAdmittedPresentUserHostInvocation(context, ACTION_INVOKE_ACTION_ID_V1)
    || !review || consumedConfirmations.has(review) || review.actionId !== ACTION_INVOKE_ACTION_ID_V1
    || review.requestId !== context.actionRequestId || review.decidingAccountId !== context.runtimeAccountId
    || review.inputDigest !== computeActionInputApprovalDigestV1(ACTION_INVOKE_ACTION_ID_V1, input)) return false;
  consumedConfirmations.add(review);
  return true;
}
