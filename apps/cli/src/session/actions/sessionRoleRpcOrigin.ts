import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import type { SessionActionRpcOriginV1 } from '@happier-dev/protocol/socketRpc';

export function resolveSessionRoleRpcOrigin(context: ActionExecutorContext): SessionActionRpcOriginV1 {
  const source = context.sessionInputSource;
  if (context.actionCaller?.kind !== 'session' || !source || typeof source !== 'object' || !('sourceSessionId' in source)
    || source.sourceSessionId !== context.actionCaller.sessionId) {
    throw Object.assign(new Error('role_rpc_origin_unavailable'), { code: 'role_rpc_origin_unavailable' });
  }
  const permissionMode = context.callerPermissionMode ? parseAgentPermissionIntentV1Alias(context.callerPermissionMode) : null;
  if (context.callerPermissionMode && !permissionMode) {
    throw Object.assign(new Error('role_rpc_origin_unavailable'), { code: 'role_rpc_origin_unavailable' });
  }
  const origin = SessionActionRpcOriginV1Schema.safeParse({
    v: 1, caller: context.actionCaller,
    callerPermissionMode: permissionMode,
    causalPermissionAuthority: context.causalPermissionAuthority ?? null,
    sourceTurnId: source && 'sourceTurnId' in source ? source.sourceTurnId : undefined,
    requestId: context.actionRequestId,
    ...(context.workspaceWrites ? { workspaceWrites: context.workspaceWrites } : {}),
  });
  if (!origin.success) {
    throw Object.assign(new Error('role_rpc_origin_unavailable'), { code: 'role_rpc_origin_unavailable' });
  }
  return origin.data;
}
