import {
  resolveConnectedServiceSessionSelection,
} from '@happier-dev/agents';
import {
  ConnectedServicesDefaultAuthByAgentIdV1Schema,
  ConnectedServiceBindingsV1Schema,
  type ConnectedServiceBindingSelectionV1,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import { resolveCatalogAgentConnectedServiceIds } from '@/agent/catalog/registry';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';

export function agentSupportsSpawnConnectedServicesDefaults(agentId: string): boolean {
  return resolveCatalogAgentConnectedServiceIds(agentId).length > 0;
}

export type SpawnConnectedServicesDefaultDisposition =
  | Readonly<{ kind: 'connected'; bindings: ConnectedServiceBindingsV1 }>
  | Readonly<{ kind: 'native' }>
  | Readonly<{
      kind: 'unavailable';
      reason: 'connected_services_default_settings_invalid';
    }>;

export class ConnectedServicesDefaultUnavailableError extends Error {
  readonly code = 'connected_services_default_unavailable';

  constructor(readonly reason: 'connected_services_default_settings_invalid') {
    super(reason);
  }
}

/**
 * THE session spawn-defaulting owner (one defaulting owner, one settings path — QA2-F02).
 *
 * Resolves the account-default connected-services selection for a catalog Agent from a FRESH,
 * bounded blocking account-settings bootstrap (`bootstrapAccountSettingsContext` mode 'blocking';
 * its network reads carry internal 15s timeouts, so the wait is bounded). Callers must NEVER
 * substitute an in-process settings snapshot for this resolution: a second settings surface is
 * exactly the stale-snapshot split-brain that silently killed run defaulting live (QA2-F02).
 * Consumed by session spawn (createCliActionDeps) AND execution-run start (connectedServicesEnv).
 * Fails to null (no defaults) on any bootstrap/validation failure.
 */
export async function resolveSessionSpawnConnectedServicesDefaultsPayload(params: Readonly<{
  agentId: string;
  credentials: StoredCredentials;
}>): Promise<Readonly<{
  connectedServices: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt: number;
}> | null> {
  const agentId = params.agentId.trim();
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
      throw new ConnectedServicesDefaultUnavailableError(disposition.reason);
    }
    if (disposition.kind === 'native') return null;
    return {
      connectedServices: disposition.bindings,
      connectedServicesUpdatedAt: Date.now(),
    };
  } catch (error) {
    if (error instanceof ConnectedServicesDefaultUnavailableError) throw error;
    return null;
  }
}

function normalizeBindingForSpawn(
  serviceId: string,
  binding: ConnectedServiceBindingSelectionV1 | undefined,
): ConnectedServiceBindingSelectionV1 {
  const resolution = resolveConnectedServiceSessionSelection({
    serviceId,
    binding,
    availability: { kind: 'deferred' },
  });
  return resolution.status === 'no_selection'
    ? { source: 'native' }
    : { source: 'connected', ...resolution.selection };
}

export function resolveSpawnConnectedServicesDefaultDisposition(params: Readonly<{
  accountSettings: unknown;
  agentId: string;
}>): SpawnConnectedServicesDefaultDisposition {
  const supportedServiceIds = resolveCatalogAgentConnectedServiceIds(params.agentId);
  if (supportedServiceIds.length === 0) return { kind: 'native' };

  const settingsRecord = params.accountSettings && typeof params.accountSettings === 'object' && !Array.isArray(params.accountSettings)
    ? params.accountSettings as { connectedServicesDefaultAuthByAgentIdV1?: unknown }
    : {};
  if (!Object.prototype.hasOwnProperty.call(settingsRecord, 'connectedServicesDefaultAuthByAgentIdV1')) {
    return { kind: 'native' };
  }
  const parsedDefaults = ConnectedServicesDefaultAuthByAgentIdV1Schema.safeParse(
    settingsRecord.connectedServicesDefaultAuthByAgentIdV1,
  );
  if (!parsedDefaults.success) {
    return {
      kind: 'unavailable',
      reason: 'connected_services_default_settings_invalid',
    };
  }

  const configuredBindings = parsedDefaults.data.bindingsByAgentId[params.agentId]?.bindingsByServiceId ?? {};
  const bindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV1> = {};
  let hasConnectedBinding = false;

  for (const serviceId of supportedServiceIds) {
    const binding = normalizeBindingForSpawn(serviceId, configuredBindings[serviceId]);
    bindingsByServiceId[serviceId] = binding;
    if (binding.source === 'connected') {
      hasConnectedBinding = true;
    }
  }

  if (!hasConnectedBinding) return { kind: 'native' };
  return {
    kind: 'connected',
    bindings: ConnectedServiceBindingsV1Schema.parse({
      v: 1,
      bindingsByServiceId,
    }),
  };
}

export function resolveSpawnConnectedServicesDefaults(params: Readonly<{
  accountSettings: unknown;
  agentId: string;
}>): ConnectedServiceBindingsV1 | null {
  const disposition = resolveSpawnConnectedServicesDefaultDisposition(params);
  return disposition.kind === 'connected' ? disposition.bindings : null;
}
