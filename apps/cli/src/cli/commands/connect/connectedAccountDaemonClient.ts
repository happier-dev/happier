import type {
  ConnectedAccountDaemonControlCommand,
  ConnectedAccountDaemonControlResponse,
  ConnectedAccountDaemonCommand,
  ConnectedAccountAttemptResponse,
} from '@/daemon/connectedServices/ConnectedAccountDaemonRuntime';
import {
  CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
  CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
  ConnectedAccountAuthenticationCommandResponseSchema,
  ConnectedAccountControlCommandRequestSchema,
  ConnectedAccountDaemonControlResponseSchema,
  ConnectedAccountDaemonCommandSchema,
} from '@/api/machine/rpcHandlers.connectedAccounts';
import type { StoredCredentials } from '@/persistence';
import {
  callMachineRpc as callMachineRpcRuntime,
} from '@/session/transport/rpc/machineRpc';

export type ConnectedAccountDaemonClient = Readonly<{
  authenticate(
    command: ConnectedAccountDaemonCommand,
  ): Promise<ConnectedAccountAttemptResponse>;
  control(
    command: ConnectedAccountDaemonControlCommand,
  ): Promise<ConnectedAccountDaemonControlResponse>;
}>;

export function createConnectedAccountDaemonClient(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  callMachineRpc?: typeof callMachineRpcRuntime;
}>): ConnectedAccountDaemonClient {
  const machineId = params.machineId.trim();
  if (!machineId) {
    throw new Error('Connected-account daemon client requires a machine id');
  }
  const callMachineRpc = params.callMachineRpc ?? callMachineRpcRuntime;

  return Object.freeze({
    async authenticate(command) {
      const normalizedCommand =
        ConnectedAccountDaemonCommandSchema.parse(command);
      const result = await callMachineRpc({
        credentials: params.credentials,
        machineId,
        method: CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
        request: {
          v: 1,
          machineId,
          command: normalizedCommand,
        },
      });
      return ConnectedAccountAuthenticationCommandResponseSchema.parse(result);
    },
    async control(command) {
      const request = ConnectedAccountControlCommandRequestSchema.parse({
        v: 1,
        machineId,
        command,
      });
      const result = await callMachineRpc({
        credentials: params.credentials,
        machineId,
        method: CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
        request,
      });
      return ConnectedAccountDaemonControlResponseSchema.parse(result);
    },
  });
}
