import { createExternalActionDaemonDispatchResponse, ExternalActionDaemonDispatchRequestSchema, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, prepareExternalActionResponseEnvelopeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ActionExecuteResult, ExternalActionDaemonDispatchRequest, ExternalActionDaemonDispatchResultV1 } from '@happier-dev/protocol';
import { isSocketRpcActionApiServerOriginAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type {
  ExternalActionExecutor,
  ResolveExternalActionTarget,
  ResolveExternalActionEncryption,
} from '@/daemon/externalActions/executeExternalAction';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';

export type ExternalActionRpcRegistrationOptions = Readonly<{
  machineId: string;
  /** Set only by a receiver that executes inside exactly one Session. */
  sessionId?: string;
  currentServerId: string;
  resolveAccountId: (signal?: AbortSignal) => Promise<string | null>;
  resolveTarget: ResolveExternalActionTarget;
  executor: ExternalActionExecutor;
  resolveEncryption?: ResolveExternalActionEncryption;
  externalActionMachineRequestPrivateKey?: string | Uint8Array;
}>;

/** Shared Action-owner dependencies; transport adapters add only identity facts. */
export type ExternalActionIngressOwner = Readonly<Pick<
  ExternalActionRpcRegistrationOptions,
  | 'currentServerId'
  | 'resolveTarget'
  | 'executor'
  | 'resolveEncryption'
  | 'externalActionMachineRequestPrivateKey'
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

type ExternalActionDaemonRelayAdmissionResult = ExternalActionDaemonRelayResponse | Readonly<{
  kind: 'invalid_request';
  errorCode: 'target_not_local';
  requestId: string;
}>;

function response(
  request: ExternalActionDaemonDispatchRequest,
  execution: ActionExecuteResult,
): ExternalActionDaemonRelayResponse {
  return createExternalActionDaemonDispatchResponse(
    prepareExternalActionResponseEnvelopeV1({
      v: 1,
      actionId: request.actionId,
      ...(request.envelope.requestId === undefined ? {} : { requestId: request.envelope.requestId }),
      execution,
    }),
  );
}

function targetNotLocal(request: ExternalActionDaemonDispatchRequest): ExternalActionDaemonRelayAdmissionResult {
  if (request.envelope.v === 2) {
    return {
      kind: 'invalid_request',
      errorCode: 'target_not_local',
      requestId: request.envelope.requestId,
    };
  }
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
    const parsed = ExternalActionDaemonDispatchRequestSchema.safeParse(raw);
    if (!parsed.success) return forbidden();
    const request = parsed.data;
    if (
      request.placement.machineId !== options.machineId
      || request.placement.target.machineId !== options.machineId
    ) {
      return targetNotLocal(request);
    }
    if (!request.executionAuthorization || !options.externalActionMachineRequestPrivateKey) {
      return forbidden();
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
      ...(options.sessionId === undefined ? {} : { currentSessionId: options.sessionId }),
      currentServerId: options.currentServerId,
      resolveEncryption: options.resolveEncryption,
      resolveTarget: options.resolveTarget,
      executor: options.executor,
      executionAuthorization: request.executionAuthorization,
      externalActionMachineRequestPrivateKey: options.externalActionMachineRequestPrivateKey,
      ...(signal ? { signal } : {}),
    });
    if (result.kind === 'invalid_request') return result;
    return createExternalActionDaemonDispatchResponse(result.prepared);
  });
}
