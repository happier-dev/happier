import type {
  ConnectedAccountDaemonControlCommand,
  ConnectedAccountDaemonControlResponse,
  ConnectedAccountDaemonCommand,
  ConnectedAccountAttemptResponse,
} from '@/daemon/connectedServices/ConnectedAccountDaemonRuntime';
import {
  CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
  ConnectedAccountAuthenticationCommandResponseSchema,
  ConnectedAccountControlCommandRequestSchema,
  ConnectedAccountDaemonControlResponseSchema,
  ConnectedAccountDaemonCommandSchema,
} from '@/api/machine/rpcHandlers.connectedAccounts';
import type { StoredCredentials } from '@/persistence';
import { randomUUID } from 'node:crypto';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_ID_BY_OPERATION,
  CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import {
  callMachineRpc as callMachineRpcRuntime,
} from '@/session/transport/rpc/machineRpc';

export type ConnectedAccountCliControlResponse = Exclude<ConnectedAccountDaemonControlResponse, { status: 'configurationCommitted' }>
  | Readonly<{ status: 'configurationCommitted'; configuration: Readonly<{ revision: string }> }>;

export type ConnectedAccountDaemonClient = Readonly<{
  authenticate(
    command: ConnectedAccountDaemonCommand,
  ): Promise<ConnectedAccountAttemptResponse>;
  control(
    command: ConnectedAccountDaemonControlCommand,
  ): Promise<ConnectedAccountCliControlResponse>;
}>;

export function createConnectedAccountDaemonClient(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  callMachineRpc?: typeof callMachineRpcRuntime;
  actionExecutor?: Pick<ReturnType<typeof createCliActionExecutorFromCredentials>, 'execute'>;
  signal?: AbortSignal;
}>): ConnectedAccountDaemonClient {
  const machineId = params.machineId.trim();
  if (!machineId) {
    throw new Error('Connected-account daemon client requires a machine id');
  }
  const callMachineRpc = params.callMachineRpc ?? callMachineRpcRuntime;
  let executor = params.actionExecutor;
  const execute = async (actionId: ActionId, input: unknown) => {
    executor ??= createCliActionExecutorFromCredentials({ credentials: params.credentials, machineId });
    const result = await executor.execute(actionId, input, { surface: 'cli', actionRequestId: randomUUID(),
      ...(params.signal ? { signal: params.signal } : {}) });
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode, details: result.details });
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) throw Object.assign(new Error('Approval requested'), { code: 'approval_required', details: approval.data });
    return result.result;
  };

  return Object.freeze({
    async authenticate(command) {
      const normalizedCommand =
        ConnectedAccountDaemonCommandSchema.parse(command);
      const { operation, ...operands } = normalizedCommand;
      const result = await execute(CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_ID_BY_OPERATION[operation], { machineId, ...operands });
      return ConnectedAccountAuthenticationCommandResponseSchema.parse(result);
    },
    async control(command) {
      const request = ConnectedAccountControlCommandRequestSchema.parse({
        v: 1,
        machineId,
        command,
      });
      if (request.command.operation === 'revokeAccount') {
        const { operation: _operation, ...operands } = request.command;
        return CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.revoke']
          .parse(await execute('connectedServices.accounts.revoke', { machineId, ...operands }));
      }
      if (request.command.operation === 'replaceConfiguration') {
        const { target, expectedRevision, values, secretValues } = request.command;
        const operand = target.kind === 'service' ? { service: target.service, modeId: target.modeId } : { machineId, target };
        const result = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.configuration.replace']
          .parse(await execute('connectedServices.configuration.replace', { ...operand, expectedRevision, values, secretValues }));
        return { status: 'configurationCommitted', configuration: { revision: result.revision } };
      }
      // These diagnostic reads cannot acquire credentials, advance an attempt or write configuration.
      if (request.command.operation !== 'describeService' && request.command.operation !== 'readConfiguration'
        && request.command.operation !== 'listPendingAttempts') throw new Error('Unsupported connected-account command');
      const result = await callMachineRpc({
        credentials: params.credentials,
        machineId,
        method: CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
        request,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const response = ConnectedAccountDaemonControlResponseSchema.parse(result);
      if (response.status === 'configurationCommitted') throw new Error('Unexpected configuration mutation receipt for a diagnostic read');
      return response;
    },
  });
}
