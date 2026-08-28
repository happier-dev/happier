import type { AgentId } from '@happier-dev/agents';
import type { AccountSettings, ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import { resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';
import { resolveCliConnectedServicesLaunchBindings } from '@/cli/connectedServicesLaunchAuth';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { resolveSpawnConnectedServicesDefaultDisposition } from '@/session/services/spawnConnectedServicesDefaults';

/**
 * Dev's generic direct-CLI selection owner. Provider variation remains in the
 * catalog/plugin lifecycle after this returns canonical bindings.
 */
export async function resolveDirectCliConnectedServiceBindings(params: Readonly<{
  agentId: AgentId;
  credentials: StoredCredentials;
  accountSettings: AccountSettings;
  authRaw: string | undefined;
  authJsonRaw: string | undefined;
}>): Promise<ConnectedServiceBindingsV1 | null> {
  // The resolved Agent catalog owns declared Connected Service ids for every
  // installed Agent, bundled or externally contributed.
  const supportedServiceIds = resolveCatalogAgentConnectedAccountServiceIds(params.agentId);
  if (
    supportedServiceIds.length === 0
    && params.authRaw === undefined
    && params.authJsonRaw === undefined
  ) {
    return null;
  }

  return await resolveCliConnectedServicesLaunchBindings({
    authRaw: params.authRaw,
    authJsonRaw: params.authJsonRaw,
    supportedServiceIds,
    defaultDisposition: resolveSpawnConnectedServicesDefaultDisposition({
      accountSettings: params.accountSettings,
      agentId: params.agentId,
    }),
    listInventory: async () => {
      const executor = createCliActionExecutorFromCredentials({ credentials: params.credentials });
      const result = normalizeActionExecuteResult(await executor.execute(
        'sessions.spawn.connected_services.list',
        { agentId: params.agentId, includeUnavailable: false },
        { surface: 'cli', defaultSessionId: null },
      ));
      if (!result.ok) throw new Error(result.errorMessage ?? result.errorCode);
      return result.data ?? null;
    },
  });
}
