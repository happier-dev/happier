import type { RuntimeActionExecute } from '@happier-dev/protocol/actions/executor/types';
import {
  createSimulatorPreviewRuntimeActionExecutorV1,
  dispatchSimulatorPreviewActionV1,
  SIMULATOR_ACTION_ROUTE_UNAVAILABLE_RESULT_V1,
  fetchSimulatorPreviewSnapshotV1,
  type SimulatorMachineRpcCallV1,
} from '@happier-dev/protocol/devices/simulator/runtimeActionClient';

import type { CliMachineActionCall, CliMachineActionServerScopeCurrent, CliOriginalAccountMachineActionDispatch } from './machineTransport';

/**
 * CLI, MCP and Session-tool hosts reach the addressed Machine's simulator owner
 * through the same Machine RPC methods as the app. Machine admission is decided
 * by the Machine transport's Home route policy; refusals reach the caller unchanged.
 * Device operations are whole Actions: like the app, they travel the original-Account
 * Machine Action transport, where Home admits the requester and the Machine executes.
 */
export function createCliSimulatorRuntimeActionExecute(
  host: Readonly<{ callMachineAction: CliMachineActionCall;
    dispatchOriginalAccountMachineAction: CliOriginalAccountMachineActionDispatch;
    isMachineActionServerScopeCurrent: CliMachineActionServerScopeCurrent }>,
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
      executeOnMachine: async ({ actionId, input, context }) => {
        const target = context.externalActionTarget;
        if (target?.kind !== 'machine') return SIMULATOR_ACTION_ROUTE_UNAVAILABLE_RESULT_V1;
        if (!await host.isMachineActionServerScopeCurrent({ serverId: context.serverId, machineId: target.machineId,
          context, ...(context.signal ? { signal: context.signal } : {}) })) {
          return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
        }
        const execution = await host.dispatchOriginalAccountMachineAction({ actionId, machineId: target.machineId,
          input, context, ...(context.signal ? { signal: context.signal } : {}) });
        if (!execution) return SIMULATOR_ACTION_ROUTE_UNAVAILABLE_RESULT_V1;
        return execution.ok ? execution.result : execution;
      },
      fallback,
    })(args);
  };
}
