import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpcErrors';
import { UiContributedActionExecuteResponseV1Schema, type UiContributedActionExecuteRequestV1, type UiContributedActionExecuteResponseV1 } from '@happier-dev/protocol/plugins/actions/clientInvocationV1';
import { clientActionAmbiguous } from '@happier-dev/protocol/actions/clientDispatchV1';
import type { SocketRpcAnsweringClientV1, SocketRpcAnsweringClientCandidateV1 } from '@happier-dev/protocol/socketRpc';

type ClientActionMachineRpc = Readonly<{
  callConnectedClientRpc(
    method: string,
    params: unknown,
    options: Readonly<{ timeoutMs: null; signal?: AbortSignal; answeringClient?: SocketRpcAnsweringClientV1; onIssued(): void;
      principalAccountId?: string }>,
  ): Promise<Readonly<{ ok: true; result: unknown }> | Readonly<{ ok: false; errorCode?: string; error?: string; answeringClients?: readonly SocketRpcAnsweringClientCandidateV1[] }>>;
}>;

function unavailable(clientId?: string, cause?: unknown): UiContributedActionExecuteResponseV1 {
  return {
    ok: false, errorCode: clientId ? 'client_not_available' : 'plugin_action_client_target_unavailable',
    error: clientId ? 'The selected clientId is not eligible or is disconnected' : 'No answering UI client is available',
    actionHandlerInvocation: 'notStarted',
    ...(cause === undefined ? {} : { data: { failureCause: projectActionFailureCauseV1(cause, 'plugin_action.client_rpc') } }),
  };
}

/** Uses the existing machine socket once; an uncertain effect is never retried. */
export function createClientActionMachineRpcExecutor(
  getMachineClient: () => ClientActionMachineRpc | null | undefined,
): (request: UiContributedActionExecuteRequestV1, options: Readonly<{ signal?: AbortSignal; clientId?: string; principalAccountId?: string }>) => Promise<UiContributedActionExecuteResponseV1> {
  return async (request, options) => {
    const client = getMachineClient();
    // Positive reconnect advertisements cannot prove absence. The authenticated
    // live RPC registry selects the responder; this owner settles its receipt.
    if (!client) {
      return unavailable(options.clientId);
    }
    let issued = false;
    const unknownOutcome = (cause?: unknown): UiContributedActionExecuteResponseV1 => ({
      ok: false, errorCode: 'plugin_action_outcome_unknown',
      error: 'The answering UI Action outcome is unknown',
      ...(cause === undefined ? {} : { data: { failureCause: projectActionFailureCauseV1(cause, 'plugin_action.client_rpc') } }),
    });
    try {
      const response = await client.callConnectedClientRpc(
        RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE, request,
        { timeoutMs: null, ...(options.signal ? { signal: options.signal } : {}),
          answeringClient: { requireSingle: true, ...(options.clientId ? { clientId: options.clientId } : {}) },
          ...(options.principalAccountId ? { principalAccountId: options.principalAccountId } : {}),
          onIssued: () => { issued = true; } },
      );
      if (!response.ok) {
        if (response.errorCode === RPC_ERROR_CODES.CLIENT_AMBIGUOUS) {
          const refusal = clientActionAmbiguous(response.answeringClients);
          return {
            ok: false, errorCode: refusal.errorCode, error: refusal.error,
            data: refusal.details,
            actionHandlerInvocation: 'notStarted',
          };
        }
        // Canonical method refusal proves the server routed no handler even
        // when the outbound request had already been issued.
        return !issued || response.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
          || response.errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND
          || response.errorCode === RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE
          ? unavailable(options.clientId, { code: response.errorCode }) : unknownOutcome({ code: response.errorCode });
      }
      if (isRpcMethodNotFoundResult(response.result)) return unavailable(options.clientId, response.result);
      const parsed = UiContributedActionExecuteResponseV1Schema.safeParse(response.result);
      return parsed.success ? parsed.data : unknownOutcome();
    } catch (error) {
      return issued ? unknownOutcome(error) : unavailable(options.clientId, error);
    }
  };
}
