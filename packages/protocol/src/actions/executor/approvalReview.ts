import { computeActionInputApprovalDigestV1 } from '../decisionAuthority.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import type { ActionId } from '../actionIds.js';
import type { ActionExecutorContext } from './types.js';
import { isPresentUserHostInvocation } from '../invocationAuthority.js';

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

/** Consume the host's completed confirmation only after exact normalized operation admission. */
export function admitPresentUserConfirmationV1(actionId: ActionId, input: unknown,
  context: ActionExecutorContext): NonNullable<ActionExecutorContext['presentUserApproval']> | null {
  const confirmation = context.presentUserConfirmation;
  const binding = context.externalActionExecutionAuthorization?.binding;
  if (!confirmation || consumedConfirmations.has(confirmation) || confirmation.actionId !== actionId
    // Account transport custody is checked below; it is not a second surface classifier.
    || !isPresentUserHostInvocation({ ...context, externalActionExecutionAuthorization: undefined })
    || context.actionCaller?.kind !== 'host'
    || context.externalActionCredential || context.rpcSessionAuthorization
    || binding && (!('authentication' in binding) || binding.authentication.kind !== 'account'
      || binding.sessionActionOrigin || binding.workflowActionOrigin
      || binding.accountId !== context.runtimeAccountId || binding.requestId !== context.actionRequestId
      || binding.actionId !== actionId || !sameStrictJsonValue(binding.target, context.externalActionTarget)
      // The existing request/operation owner admits or rejoins a carried
      // confirmation before this consumer can honor it. Do not duplicate its
      // request identity or receipt checks here.
      || context.operationAcceptance?.actionId !== actionId)
    || !context.runtimeAccountId || !context.actionRequestId
    || confirmation.accountId !== context.runtimeAccountId || confirmation.requestId !== context.actionRequestId
    || confirmation.serverId !== (context.serverIdentityId ?? context.serverId)
    || !sameStrictJsonValue(confirmation.target ?? null, context.externalActionTarget ?? null)
    || confirmation.inputDigest !== computeActionInputApprovalDigestV1(actionId, input, context.sessionTargetsV1)) return null;
  consumedConfirmations.add(confirmation);
  return recordPresentUserApprovalV1({ actionId, input, requestId: context.actionRequestId,
    requestSurface: context.surface, decidingAccountId: context.runtimeAccountId, decidedAtMs: Date.now() });
}
