import {
  ExternalActionDaemonDispatchRequestV1Schema,
  EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
  type ActionExecuteResult,
  type ExternalActionDaemonDispatchRequestV1,
  type ExternalActionDaemonDispatchResultV1,
} from '@happier-dev/protocol';
import {
  isSocketRpcActionApiServerOriginAuthorizationContext,
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
} from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type {
  ExternalActionExecutor,
  ResolveExternalActionTarget,
} from '@/daemon/externalActions/executeExternalAction';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';

export type ExternalActionRpcRegistrationOptions = Readonly<{
  machineId: string;
  currentServerId: string;
  resolveAccountId: (signal?: AbortSignal) => Promise<string | null>;
  resolveTarget: ResolveExternalActionTarget;
  executor: ExternalActionExecutor;
}>;

/** Shared Action-owner dependencies; transport adapters add only identity facts. */
export type ExternalActionIngressOwner = Readonly<Pick<
  ExternalActionRpcRegistrationOptions,
  'currentServerId' | 'resolveTarget' | 'executor'
>>;

function forbidden() {
  return {
    error: RPC_ERROR_MESSAGES.FORBIDDEN,
    errorCode: RPC_ERROR_CODES.FORBIDDEN,
  };
}

type ExternalActionDaemonRelayResponse = Extract<
  ExternalActionDaemonDispatchResultV1,
  Readonly<{ kind: 'response' }>
>;

function response(
  request: ExternalActionDaemonDispatchRequestV1,
  execution: ActionExecuteResult,
): ExternalActionDaemonRelayResponse {
  return {
    kind: 'response',
    response: {
      v: 1,
      actionId: request.actionId,
      ...(request.envelope.requestId === undefined ? {} : { requestId: request.envelope.requestId }),
      execution,
    },
  };
}

function targetNotLocal(request: ExternalActionDaemonDispatchRequestV1): ExternalActionDaemonRelayResponse {
  return response(request, {
    ok: false,
    errorCode: 'target_not_local',
    error: 'target_not_local',
  });
}

export function registerExternalActionRpcHandler(
  rpc: RpcHandlerRegistrar,
  options: ExternalActionRpcRegistrationOptions,
): void {
  rpc.registerHandler(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, async (raw, context) => {
    // RpcHandlerManager also rejects this before dispatch. Keep the assertion
    // at the receiver so an in-process registrar cannot bypass the closed
    // server-origin transport contract.
    if (!isSocketRpcActionApiServerOriginAuthorizationContext(context?.authorization)) {
      return forbidden();
    }
    const parsed = ExternalActionDaemonDispatchRequestV1Schema.safeParse(raw);
    if (!parsed.success) return forbidden();
    const request = parsed.data;
    if (
      request.placement.machineId !== options.machineId
      || request.placement.target.machineId !== options.machineId
    ) {
      return targetNotLocal(request);
    }

    const signal = context?.signal;
    let accountId: string | null;
    try {
      accountId = await options.resolveAccountId(signal);
    } catch {
      accountId = null;
    }
    if (signal?.aborted || accountId !== request.principal.accountId) {
      return targetNotLocal(request);
    }

    const result = await executeExternalAction({
      actionId: request.actionId,
      envelope: request.envelope,
      principal: request.principal,
      currentMachineId: options.machineId,
      currentServerId: options.currentServerId,
      resolveTarget: options.resolveTarget,
      executor: options.executor,
      ...(signal ? { signal } : {}),
    });
    return result;
  });
}
