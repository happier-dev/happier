import { createActionExecutor, getActionSpec, type ActionExecutorDeps, type ActionId } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { SessionEncryptionContext } from './sessionEncryptionContext';
import { callSessionRpc } from './sessionRpc';

function notSupported(): never {
  throw new Error('action_not_supported_in_session_control_cli');
}

export function createSessionControlActionExecutor(params: Readonly<{
  token: string;
  sessionId: string;
  ctx: SessionEncryptionContext;
}>): ReturnType<typeof createActionExecutor> {
  const callExecutionRunRpc = async (methodSuffix: string, request: unknown): Promise<unknown> => {
    return await callSessionRpc({
      token: params.token,
      sessionId: params.sessionId,
      ctx: params.ctx,
      method: `${params.sessionId}:${methodSuffix}`,
      request,
    });
  };

  const deps: ActionExecutorDeps = {
    executionRunStart: async (_sessionId, request) => await callExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_START, request),
    executionRunList: async (_sessionId, request) => await callExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, request),
    executionRunGet: async (_sessionId, request) => await callExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_GET, request),
    executionRunSend: async (_sessionId, request) => await callExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, request),
    executionRunStop: async (_sessionId, request) => await callExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, request),
    executionRunAction: async (_sessionId, request) =>
      await callExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, request),

    // These actions are not exposed on the session-control CLI surface today.
    sessionOpen: async () => notSupported(),
    sessionSpawnNew: async () => notSupported(),
    sessionSendMessage: async () => notSupported(),
    sessionPermissionRespond: async () => notSupported(),
    sessionTargetPrimarySet: async () => notSupported(),
    sessionTargetTrackedSet: async () => notSupported(),
    sessionList: async () => notSupported(),
    sessionActivityGet: async () => notSupported(),
    sessionRecentMessagesGet: async () => notSupported(),
    resetGlobalVoiceAgent: () => notSupported(),

    isActionEnabled: (actionId: ActionId) => {
      // Fail-closed: only allow specs explicitly surfaced for session-control CLI.
      return getActionSpec(actionId).surfaces.session_control_cli === true;
    },
  };

  return createActionExecutor(deps);
}

