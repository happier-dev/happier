import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { UiActionDispatchRequestV1Schema, clientActionUnavailable, parseClientActionDispatchResult } from '@happier-dev/protocol/actions/clientDispatchV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol';

export type ClientActionMachineRpc = Readonly<{
  hasConnectedClientRpcHandler(method: string): boolean;
  callConnectedClientRpc(method: string, params: unknown,
    options: Readonly<{ timeoutMs: null; signal?: AbortSignal; onIssued(): void }>):
    Promise<Readonly<{ ok: true; result: unknown }> | Readonly<{ ok: false; errorCode?: string }>>;
}>;

/** One delivery owner for every built-in client-placed Action; no retry after issuance. */
export function createClientActionReverseDispatcher(
  getMachineClient: () => ClientActionMachineRpc | null | undefined,
): NonNullable<ActionExecutorDeps['clientActionExecute']> {
  return async ({ actionId, input, context }) => {
    const unavailable = () => clientActionUnavailable(actionId);
    const client = getMachineClient();
    if (!client?.hasConnectedClientRpcHandler(RPC_METHODS.UI_ACTION_EXECUTE)) return unavailable();
    if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    const request = UiActionDispatchRequestV1Schema.safeParse({ v: 1, actionId, input, context: {
      surface: context.surface ?? 'agent', authority: context.authority ?? 'account_automation',
      ...(context.defaultSessionId ? { defaultSessionId: context.defaultSessionId } : {}),
      ...(context.defaultSessionMachineId ? { defaultSessionMachineId: context.defaultSessionMachineId } : {}),
      ...(context.agentStartWorkspaceWrites ? { agentStartWorkspaceWrites: context.agentStartWorkspaceWrites } : {}),
    } });
    if (!request.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    let issued = false;
    const unknownOutcome = () => ({ ok: false as const, errorCode: 'outcome_uncertain', error: 'outcome_uncertain' });
    try {
      const response = await client.callConnectedClientRpc(RPC_METHODS.UI_ACTION_EXECUTE, request.data, {
        timeoutMs: null, ...(context.signal ? { signal: context.signal } : {}), onIssued: () => {
          issued = true;
          context.onTransportIssued?.();
        },
      });
      if (!response.ok) return !issued || response.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE ? unavailable() : unknownOutcome();
      return parseClientActionDispatchResult(actionId, response.result) ?? unknownOutcome();
    } catch {
      return issued ? unknownOutcome() : unavailable();
    }
  };
}
