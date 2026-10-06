import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { UiContributedActionExecuteResponseV1Schema } from '@happier-dev/protocol/plugins/actions/clientInvocationV1';

import type { ClientContributedActionExecutor, PluginActionExecutorResult } from './executeContributedAction';

type ClientActionMachineRpc = Readonly<{
  hasConnectedClientRpcHandler(method: string): boolean;
  callConnectedClientRpc(
    method: string,
    params: unknown,
    options: Readonly<{ timeoutMs: null; signal?: AbortSignal; onIssued(): void }>,
  ): Promise<Readonly<{ ok: true; result: unknown }> | Readonly<{ ok: false; errorCode?: string; error?: string }>>;
}>;

function unavailable(): PluginActionExecutorResult {
  return {
    ok: false, errorCode: 'plugin_action_client_target_unavailable',
    error: 'No answering UI client is available', actionHandlerInvocation: 'notStarted',
  };
}

/** Uses the existing machine socket once; an uncertain effect is never retried. */
export function createClientActionMachineRpcExecutor(
  getMachineClient: () => ClientActionMachineRpc | null | undefined,
): ClientContributedActionExecutor {
  return async (request, options) => {
    const client = getMachineClient();
    if (!client || !client.hasConnectedClientRpcHandler(RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE)) {
      return unavailable();
    }
    let issued = false;
    const unknownOutcome = (): PluginActionExecutorResult => ({
      ok: false, errorCode: 'plugin_action_outcome_unknown',
      error: 'The answering UI Action outcome is unknown',
    });
    try {
      const response = await client.callConnectedClientRpc(
        RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE, request,
        { timeoutMs: null, ...(options.signal ? { signal: options.signal } : {}), onIssued: () => { issued = true; } },
      );
      if (!response.ok) {
        // Canonical method refusal proves the server routed no handler even
        // when the outbound request had already been issued.
        return !issued || response.errorCode === 'RPC_METHOD_NOT_AVAILABLE'
          ? unavailable() : unknownOutcome();
      }
      const parsed = UiContributedActionExecuteResponseV1Schema.safeParse(response.result);
      return parsed.success ? parsed.data : unknownOutcome();
    } catch {
      return issued ? unknownOutcome() : unavailable();
    }
  };
}
