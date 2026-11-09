import { isDeepStrictEqual } from 'node:util';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import type { SessionActionRpcOriginV1 } from '@happier-dev/protocol/socketRpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

function originUnavailable() {
  return Object.assign(new RpcError('role_rpc_origin_unavailable', 'role_rpc_origin_unavailable'), {
    code: 'role_rpc_origin_unavailable',
  });
}

/** Home has verified the assigned executor's signature before this receiving path.
 * Its Session witness binds the admitted Run and captured start baseline;
 * a receiving process's plugin slots cannot establish the source's authority.
 */
export function hasReceivedWorkflowSessionRoleAuthority(params: Readonly<{
  context: ActionExecutorContext;
  accountId: string;
  sessionId: string;
}>): boolean {
  const { context } = params;
  const binding = context.externalActionExecutionAuthorization?.binding;
  const origin = binding?.workflowActionOrigin;
  const caller = context.actionCaller;
  return !!origin?.sessionAuthority && caller?.kind === 'workflowRun'
    && context.authority === 'account_automation'
    && binding?.accountId === params.accountId
    && binding.target.kind === 'session' && binding.target.sessionId === params.sessionId
    && binding.requestId === context.actionRequestId && origin.requestId === binding.requestId
    && origin.runId === caller.runId
    && isDeepStrictEqual(origin.sessionAuthority.authorization, caller.authorization);
}

export function resolveSessionRoleRpcOrigin(context: ActionExecutorContext): SessionActionRpcOriginV1 {
  const source = context.sessionInputSource;
  if (context.actionCaller?.kind !== 'session' || !source || typeof source !== 'object' || !('sourceSessionId' in source)
    || source.sourceSessionId !== context.actionCaller.sessionId) {
    throw originUnavailable();
  }
  const permissionMode = context.callerPermissionMode ? parseAgentPermissionIntentV1Alias(context.callerPermissionMode) : null;
  if (context.callerPermissionMode && !permissionMode) {
    throw originUnavailable();
  }
  const origin = SessionActionRpcOriginV1Schema.safeParse({
    v: 1, caller: context.actionCaller,
    callerPermissionMode: permissionMode,
    causalPermissionAuthority: context.causalPermissionAuthority ?? null,
    ...(context.actionRequestAttributionV1 ? { actionRequestAttributionV1: context.actionRequestAttributionV1 } : {}),
    sourceTurnId: source && 'sourceTurnId' in source ? source.sourceTurnId : undefined,
    ...('sourceInputId' in source ? { sourceInputId: source.sourceInputId } : {}),
    requestId: context.actionRequestId,
    ...(context.workspaceWrites ? { workspaceWrites: context.workspaceWrites } : {}),
  });
  if (!origin.success) {
    throw originUnavailable();
  }
  return origin.data;
}
