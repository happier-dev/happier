import type { RpcHandlerContext } from '@/api/rpc/types';
import { createExternalActionDaemonDispatchResponse, ExternalActionDaemonDispatchRequestSchema, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, prepareExternalActionResponseEnvelopeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ActionExecuteResult, ExternalActionDaemonDispatchRequest, ExternalActionDaemonDispatchResultV1 } from '@happier-dev/protocol';
import type { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isSocketRpcActionApiServerOriginAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type {
  ExternalActionExecutor,
  ResolveExternalActionTarget,
  ResolveExternalActionEncryption,
  VerifyExternalActionExecutionAuthorization,
  PrepareExternalActionRequesterAccountContext,
} from '@/daemon/externalActions/executeExternalAction';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { traceExternalActionStage } from '@/daemon/externalActions/externalActionPhase';
import { isOriginalSessionInputAccountActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionProjection';

export type ExternalActionRpcRegistrationOptions = Readonly<{
  machineId: string;
  /** Set only by a receiver that executes inside exactly one Session. */
  sessionId?: string;
  currentServerId: string;
  currentServerHttpBaseUrl?: string;
  resolveAccountId: (signal?: AbortSignal) => Promise<string | null>;
  resolveInstallationId: () => string | null;
  verifyExecutionAuthorization: VerifyExternalActionExecutionAuthorization;
  resolveTarget: ResolveExternalActionTarget;
  executor: ExternalActionExecutor & Partial<Pick<ReturnType<typeof createActionExecutor>,
    'replayApprovedApprovalRequest' | 'continueConfidentialApprovalRequest'>>;
  resolveEncryption?: ResolveExternalActionEncryption;
  prepareRequesterAccountContext?: PrepareExternalActionRequesterAccountContext;
  invokeResource?: Parameters<typeof executeExternalAction>[0]['invokeResource'];
  externalActionMachineRequestPrivateKey?: string | Uint8Array;
  acquirePluginRuntimeRegistryLease?: Parameters<typeof executeExternalAction>[0]['acquirePluginRuntimeRegistryLease'];
  resolvePluginExecutionOriginContext?: Parameters<typeof executeExternalAction>[0]['resolvePluginExecutionOriginContext'];
  resolveAccountPluginExecutionSelection?: Parameters<typeof executeExternalAction>[0]['resolveAccountPluginExecutionSelection'];
}>;

/** Shared Action-owner dependencies; transport adapters add only identity facts. */
export type ExternalActionIngressOwner = Readonly<Pick<
  ExternalActionRpcRegistrationOptions,
  | 'currentServerId'
  | 'currentServerHttpBaseUrl'
  | 'prepareRequesterAccountContext'
  | 'resolveTarget'
  | 'executor'
  | 'resolveEncryption'
  | 'externalActionMachineRequestPrivateKey'
  | 'acquirePluginRuntimeRegistryLease'
  | 'resolvePluginExecutionOriginContext'
  | 'resolveAccountPluginExecutionSelection'
  | 'invokeResource'
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
    const trace = (stage: string) => traceExternalActionStage(request.actionId, request.envelope.requestId, stage, context?.transportRequestId);
    trace('rpc.received');
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
      trace('rpc.account_resolution.begin');
      accountId = await options.resolveAccountId(signal);
    } catch {
      accountId = null;
    }
    trace('rpc.account_resolution.end');
    const installationId = options.resolveInstallationId();
    if (
      signal?.aborted
      || accountId !== request.executionAuthorization.binding.custodianAccountId
      || installationId !== request.executionAuthorization.binding.installationId
      // Shared execution remains closed until its Account-scoped dependency
      // ports preserve the actor independently of the daemon custodian.
      || (accountId !== request.principal.accountId
        && (!options.prepareRequesterAccountContext || !request.executionAuthorization.requesterAccountContext
          && !isOriginalSessionInputAccountActionCustody(request.executionAuthorization.binding)))
    ) {
      return targetNotLocal(request);
    }

    const result = await executeExternalAction({
      actionId: request.actionId,
      envelope: request.envelope,
      principal: request.principal,
      currentMachineId: options.machineId,
      ...(options.sessionId === undefined ? {} : { currentSessionId: options.sessionId }),
      currentServerId: options.currentServerId,
      currentAccountId: accountId,
      currentServerHttpBaseUrl: options.currentServerHttpBaseUrl,
      prepareRequesterAccountContext: options.prepareRequesterAccountContext,
      currentInstallationId: installationId,
      // HTTP-port reconstruction reuses this ingress's admitted root. Keep
      // installation retirement local; fresh effect admission stays below.
      isInstallationCurrent: () => options.resolveInstallationId() === installationId,
      verifyExecutionAuthorization: async (input) => {
        if (options.resolveInstallationId() !== installationId) return false;
        const current = await options.verifyExecutionAuthorization(input);
        return current && options.resolveInstallationId() === installationId;
      },
      resolveEncryption: options.resolveEncryption,
      resolveTarget: options.resolveTarget,
      executor: options.executor,
      invokeResource: options.invokeResource,
      acquirePluginRuntimeRegistryLease: options.acquirePluginRuntimeRegistryLease,
      resolvePluginExecutionOriginContext: options.resolvePluginExecutionOriginContext,
      resolveAccountPluginExecutionSelection: options.resolveAccountPluginExecutionSelection,
      executionAuthorization: request.executionAuthorization,
      externalActionMachineRequestPrivateKey: options.externalActionMachineRequestPrivateKey,
      transportRequestId: context?.transportRequestId,
      ...(context?.machineAdmission ? { machineAdmission: context.machineAdmission } : {}),
      ...(signal ? { signal } : {}),
    });
    trace('rpc.completed');
    if (result.kind === 'invalid_request') return result;
    return createExternalActionDaemonDispatchResponse(result.prepared);
  });
}

export type ExternalActionApprovalReplay = (
  args: Parameters<ReturnType<typeof createActionExecutor>['replayApprovedApprovalRequest']>[0],
  machineIngress?: Pick<RpcHandlerContext, 'signal' | 'machineAdmission' | 'verifyMachineAdmissionCurrent'>,
) => ReturnType<ReturnType<typeof createActionExecutor>['replayApprovedApprovalRequest']>;
