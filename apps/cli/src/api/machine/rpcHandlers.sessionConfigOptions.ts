import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcError } from '@happier-dev/protocol/rpc/errors';
import { SessionConfigOptionRequestSchema, SessionConfigOptionTargetSchema } from '@happier-dev/protocol/sessions/control/sessionConfigOptionV1';

import { readStoredCredentials } from '@/persistence';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import {
  readSessionConfigOptionChoicesForTarget,
  writeSessionConfigOptionForTarget,
} from '@/providers/sessions/sessionConfigOptionControl';
import type { MachineProviderRpcServices } from './rpcHandlers.providers';

export function registerMachineSessionConfigOptionRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  machineId: string;
  serverId?: string;
  providerRpc?: Pick<MachineProviderRpcServices, 'projectModels'>;
  readCredentials?: typeof readStoredCredentials;
}>): void {
  const environment = async (context?: RpcHandlerContext) => {
    const credentials = await (params.readCredentials ?? readStoredCredentials)(params.serverId ? { serverId: params.serverId } : undefined);
    if (!credentials) throw new RpcError('not_authenticated', 'not_authenticated');
    const providerRpc = params.providerRpc;
    return {
      credentials, machineId: params.machineId, signal: context?.signal,
      ...(providerRpc ? { readProviderModels: (request: Parameters<MachineProviderRpcServices['projectModels']>[0]) =>
        providerRpc.projectModels(request, context?.signal, context) } : {}),
    };
  };
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_CONFIG_OPTION_CHOICES, async (raw, context) => {
    const { sessionId } = SessionConfigOptionTargetSchema.parse(raw);
    return await readSessionConfigOptionChoicesForTarget(sessionId, await environment(context));
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_CONFIG_OPTION_SET, async (raw, context) => {
    const request = SessionConfigOptionRequestSchema.parse(raw);
    return await writeSessionConfigOptionForTarget(request, await environment(context));
  });
}
