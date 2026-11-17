import type { CliMachineActionCall } from './machineTransport';
import type { CliActionDepsParams } from './types';
import { createCliSettingsDeclarationAction } from '../settingsDeclarationAction';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
export function createCliSettingsActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'isCredentialCurrent' | 'serverHttpBaseUrl' | 'serverId' | 'savedSecretOperationContext'>,
  { callMachineAction }: Readonly<{
    callMachineAction: CliMachineActionCall;
  }>,
): Pick<ActionExecutorDeps, 'settingsDeclarationAction'> {
  return {

    settingsDeclarationAction: createCliSettingsDeclarationAction({ credentials: params.credentials,
      serverId: params.serverId ?? configuration.activeServerId,
      serverHttpBaseUrl: params.serverHttpBaseUrl, isCredentialCurrent: params.isCredentialCurrent,
      savedSecretOperationContext: params.savedSecretOperationContext,
      readMachineAgentProjection: async (machineId, context) => {
        const readProjection = async () => {
          let raw: unknown;
          try {
            raw = await callMachineAction({ machineId, serverId: params.serverId ?? configuration.activeServerId,
              method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
              request: { machineId, selection: 'agents' }, exactMachine: true,
              context, authority: context.authority, ...(context.signal ? { signal: context.signal } : {}),
            });
          } catch {
            context.signal?.throwIfAborted();
            return null;
          }
          const response = DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(raw);
          return response.success ? response.data.projection : null;
        };
        return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, readProjection) : readProjection());
      } }),
  };
}
