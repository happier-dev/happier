import { AGENT_IDS, type AgentId } from '@happier-dev/agents';
import type { BackendTargetRefV1, ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { isAccountSettingsContentInvalidError } from '@/settings/accountSettings/accountSettingsRefreshError';
import {
  agentSupportsSpawnConnectedServicesDefaults,
  resolveSpawnConnectedServicesDefaultDisposition,
} from '@/session/services/spawnConnectedServicesDefaults';

export type SpawnConnectedServicesDefaultsForAccount = Readonly<{
  connectedServices: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt: number;
}>;

/**
 * Account-scoped owner for applying the user's stored connected-service defaults to a new Agent
 * runtime. Callers retain authority over stronger inputs such as an explicit selection or a
 * session's already-recorded runtime binding.
 */

export async function resolveSpawnConnectedServicesDefaultsForAccount(params: Readonly<{
  credentials: Credentials;
  backendTarget: BackendTargetRefV1;
}>): Promise<SpawnConnectedServicesDefaultsForAccount | null> {
  if (params.backendTarget.kind !== 'builtInAgent') return null;
  const agentId = params.backendTarget.agentId as AgentId;
  if (!AGENT_IDS.includes(agentId)) return null;
  if (!agentSupportsSpawnConnectedServicesDefaults(agentId)) return null;

  try {
    const accountSettingsContext = await bootstrapAccountSettingsContext({
      credentials: params.credentials,
      mode: 'blocking',
      deps: { applySideEffects: () => undefined },
    });
    const disposition = resolveSpawnConnectedServicesDefaultDisposition({
      accountSettings: accountSettingsContext.settings,
      agentId,
    });
    if (disposition.kind === 'unavailable') {
      throw new Error(disposition.reason);
    }
    if (disposition.kind === 'native') return null;
    return {
      connectedServices: disposition.bindings,
      connectedServicesUpdatedAt: Date.now(),
    };
  } catch (error) {
    if (isAccountSettingsContentInvalidError(error)) {
      throw new Error('connected_services_default_settings_invalid');
    }
    if (error instanceof Error && error.message === 'connected_services_default_settings_invalid') {
      throw error;
    }
    return null;
  }
}
