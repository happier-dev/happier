import type { RuntimeActionExecute } from '@happier-dev/protocol/actions/executor/types';
import {
  createSimulatorPreviewRuntimeActionExecutorV1,
  dispatchSimulatorPreviewActionV1,
  fetchSimulatorPreviewSnapshotV1,
  type SimulatorMachineRpcCallV1,
} from '@happier-dev/protocol/devices/simulator/runtimeActionClient';

import type { CliMachineActionCall } from './machineTransport';

/**
 * CLI, MCP and Session-tool hosts reach the addressed Machine's simulator owner
 * through the same Machine RPC methods as the app. Machine admission is decided
 * by the Machine transport's Home route policy; refusals reach the caller unchanged.
 */
export function createCliSimulatorRuntimeActionExecute(
  host: Readonly<{ callMachineAction: CliMachineActionCall }>,
  fallback: RuntimeActionExecute,
): RuntimeActionExecute {
  return async (args) => {
    const call: SimulatorMachineRpcCallV1 = ({
      machineId,
      serverId,
      method,
      payload,
      signal,
    }) =>
      host.callMachineAction({
        machineId,
        ...(serverId ? { serverId } : {}),
        method,
        request: payload,
        ...(args.context.authority
          ? { authority: args.context.authority }
          : {}),
        ...(args.context.rpcSessionAuthorization
          ? { authorization: args.context.rpcSessionAuthorization }
          : {}),
        context: args.context,
        effectActionId: args.actionId,
        exactMachine: true,
        ...(signal ? { signal } : {}),
      });
    return await createSimulatorPreviewRuntimeActionExecutorV1({
      // An unaddressed call means this host's Session Machine, as in the app.
      resolveMachineId: ({ context }) => context.defaultSessionMachineId,
      fetchSnapshot: (input) => fetchSimulatorPreviewSnapshotV1(call, input),
      dispatchAction: (input) => dispatchSimulatorPreviewActionV1(call, input),
      fallback,
    })(args);
  };
}
