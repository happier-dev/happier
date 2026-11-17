import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionExecuteResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { StoredCredentials } from '@/persistence';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';

/** Standalone clients rejoin the origin publisher; they never mint another attributed input. */
export function createOriginDaemonApprovalOutcomePublisher(input: Readonly<{
  credentials: StoredCredentials;
  serverUrl: string;
}>): NonNullable<ActionExecutorDeps['approvalRequestOutcomePublication']> {
  return async ({ artifactId, request, context }) => {
    const machineId = request.executionOriginV1.machineId?.trim();
    if (!machineId) return null;
    const result = await callExactMachineRpc({ credentials: input.credentials, serverUrl: input.serverUrl,
      machineId, method: RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED,
      request: { artifactId }, requireCurrentMachine: true, timeoutMs: null,
      ...(context.signal ? { signal: context.signal } : {}) });
    const parsed = ActionExecuteResultSchema.safeParse(result);
    return parsed.success ? parsed.data : { ok: false, errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output' };
  };
}
