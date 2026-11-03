import type { ActionExecuteResult } from '@happier-dev/protocol/actions/executor/types';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import {
  UiActionChildExecuteRequestV1Schema,
  parseClientActionDispatchResult,
} from '@happier-dev/protocol/actions/clientDispatchV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

/** The daemon that admitted and still awaits this client Action. */
export type AdmittedClientActionParent = Readonly<{
  machineId: string;
  requestId: string;
}>;

/**
 * Return a Session caller's Workflow child to the daemon holding its admitted
 * parent. This App names the parent and supplies operands only; the daemon owns
 * the caller, Session, Run and Account facts.
 */
export async function executeAdmittedClientActionChildAtMachine(
  params: Readonly<{
    parent: AdmittedClientActionParent;
    serverId: string;
    accountId: string;
    sessionId: string;
    actionId: ActionId;
    input: unknown;
    signal?: AbortSignal;
  }>,
): Promise<ActionExecuteResult> {
  const request = UiActionChildExecuteRequestV1Schema.safeParse({
    v: 1,
    parentRequestId: params.parent.requestId,
    sessionId: params.sessionId,
    actionId: params.actionId,
    input: params.input,
  });
  if (!request.success) {
    return { ok: false, errorCode: 'invalid_action_input', error: 'invalid_action_input' };
  }
  const payload = request.data;
  let raw: unknown;
  try {
    raw = await machineRpcWithServerScope<unknown, typeof payload>({
      machineId: params.parent.machineId,
      serverId: params.serverId,
      accountId: params.accountId,
      method: RPC_METHODS.UI_ACTION_CHILD_EXECUTE,
      payload,
      // Setup stays bounded; the admitted parent's lifetime bounds delivery.
      operationTimeoutMs: null,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch (error) {
    const code = params.signal?.aborted
      ? 'cancelled'
      : readRpcRequestDisposition(error) === 'notSent'
        ? 'target_unavailable'
        : 'outcome_uncertain';
    return { ok: false, errorCode: code, error: code };
  }
  return (
    parseClientActionDispatchResult(params.actionId, raw) ?? {
      ok: false,
      errorCode: 'invalid_action_output',
      error: 'invalid_action_output',
    }
  );
}
