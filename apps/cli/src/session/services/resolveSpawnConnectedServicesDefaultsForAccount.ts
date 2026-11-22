import { AGENT_IDS, type AgentId } from '@happier-dev/agents';
import type { BackendTargetRefV1, ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { dropConnectedBindingsToMissingProfiles } from '@/daemon/connectedServices/classifyMissingConnectedServiceProfile';
import { logger } from '@/ui/logger';
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
type DefaultsApi = Parameters<typeof dropConnectedBindingsToMissingProfiles>[0]['api'];

async function createDefaultsApi(credentials: Credentials): Promise<DefaultsApi> {
  const { ApiClient } = await import('@/api/api');
  return await ApiClient.create(credentials) as unknown as DefaultsApi;
}

export async function resolveSpawnConnectedServicesDefaultsForAccount(params: Readonly<{
  credentials: Credentials;
  backendTarget: BackendTargetRefV1;
  deps?: Readonly<{ createApi?: (credentials: Credentials) => Promise<DefaultsApi> }>;
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
    // A default that names a profile which no longer exists would commit the new runtime to an
    // account that can never start. Treat it as native, as the app already presents it; a profile
    // list that cannot be read changes nothing.
    let bindings = disposition.bindings;
    try {
      const api = await (params.deps?.createApi ?? createDefaultsApi)(params.credentials);
      const checked = await dropConnectedBindingsToMissingProfiles({ api, bindings });
      if (checked.dropped.length > 0) {
        logger.warn('[CONNECTED SERVICES] Account default names a profile that no longer exists; using native auth', {
          agentId,
          dropped: checked.dropped,
        });
        bindings = checked.bindings;
      }
    } catch {
      // keep the default as resolved
    }
    if (!Object.values(bindings.bindingsByServiceId).some((binding) => binding.source === 'connected')) return null;
    return {
      connectedServices: bindings,
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
