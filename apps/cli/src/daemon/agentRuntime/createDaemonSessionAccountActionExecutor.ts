import {
  getActionSpec,
  RoleActionInputSchemasV1,
  AgentStartSessionCallerV1Schema,
  readAgentStartCallerWorkDepthV1,
  type createActionExecutor,
  type ActionExecuteResult,
} from '@happier-dev/protocol';
import type { AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';

type SessionActionOperation = Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'action.execute' }>;

/** Adapts authenticated Session custody to the existing credentialed Account executor. */
export function createDaemonSessionAccountActionExecutor(params: Readonly<{
  serverId: string;
  createExecutor: (getCurrentTurnWorkDepth: (turnId?: string) => number | undefined,
    isCallerCurrent: () => Promise<boolean>) => Pick<ReturnType<typeof createActionExecutor>, 'execute'>;
}>) {
  return async (operation: SessionActionOperation, authority: Readonly<{
    sessionId: string;
    isCurrent(): Promise<boolean>;
    signal?: AbortSignal;
  }>): Promise<ActionExecuteResult> => {
    if (authority.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    if (!await authority.isCurrent()) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    if (getActionSpec(operation.actionId).executionPlacement !== 'account'
      && getActionSpec(operation.actionId).executionPlacement !== 'client'
      && !(Object.hasOwn(RoleActionInputSchemasV1, operation.actionId) && operation.actionId.startsWith('session.'))) {
      return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    }
    const witness = operation.witness;
    const caller = AgentStartSessionCallerV1Schema.safeParse(witness.agentStartCaller);
    if (!caller.success || caller.data.sessionId !== authority.sessionId
      || witness.workDepth !== readAgentStartCallerWorkDepthV1(caller.data)) {
      return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    }
    const executor = params.createExecutor((turnId) =>
      !turnId || turnId === witness.turnId ? witness.workDepth : undefined, () => authority.isCurrent());
    return await executor.execute(operation.actionId, operation.input, {
      surface: operation.surface ?? 'agent', authority: 'account_automation', serverId: params.serverId,
      actionCaller: caller.data,
      defaultSessionId: authority.sessionId, actionRequestId: operation.requestId,
      callerPermissionMode: witness.callerPermissionMode ?? null,
      causalPermissionAuthority: witness.causalPermissionAuthority ?? null,
      sessionInputSource: { sourceSessionId: authority.sessionId, sourceTurnId: witness.turnId, via: 'action' },
      ...(operation.toolCallId ? { approvalOrigin: {
        kind: 'transcript_tool_call' as const, sessionId: authority.sessionId, toolCallId: operation.toolCallId,
      } } : {}),
      ...(authority.signal ? { signal: authority.signal } : {}),
    });
  };
}
