import { AGENTS_CORE, AGENT_IDS, type AgentId } from '@happier-dev/agents';
import {
  ConnectedServicesDefaultAuthByAgentIdV1Schema,
  ConnectedServiceBindingsV1Schema,
  type ConnectedServiceBindingSelectionV1,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';

export function agentSupportsSpawnConnectedServicesDefaults(agentId: AgentId): boolean {
  return (AGENTS_CORE[agentId].connectedServices?.supportedServiceIds.length ?? 0) > 0;
}

/**
 * THE session spawn-defaulting owner (one defaulting owner, one settings path — QA2-F02).
 *
 * Resolves the account-default connected-services selection for a built-in agent from a FRESH,
 * bounded blocking account-settings bootstrap (`bootstrapAccountSettingsContext` mode 'blocking';
 * its network reads carry internal 15s timeouts, so the wait is bounded). Callers must NEVER
 * substitute an in-process settings snapshot for this resolution: a second settings surface is
 * exactly the stale-snapshot split-brain that silently killed run defaulting live (QA2-F02).
 * Consumed by session spawn (createCliActionDeps) AND execution-run start (connectedServicesEnv).
 * Fails to null (no defaults) on any bootstrap/validation failure.
 */
export async function resolveSessionSpawnConnectedServicesDefaultsPayload(params: Readonly<{
  agentId: string;
  credentials: Credentials;
}>): Promise<Readonly<{
  connectedServices: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt: number;
}> | null> {
  const agentId = params.agentId.trim();
  if (!AGENT_IDS.includes(agentId as AgentId)) return null;
  if (!agentSupportsSpawnConnectedServicesDefaults(agentId as AgentId)) return null;

  try {
    const accountSettingsContext = await bootstrapAccountSettingsContext({
      credentials: params.credentials,
      mode: 'blocking',
      deps: { applySideEffects: () => undefined },
    });
    const connectedServices = resolveSpawnConnectedServicesDefaults({
      accountSettings: accountSettingsContext.settings,
      agentId: agentId as AgentId,
    });
    if (!connectedServices) return null;
    return {
      connectedServices,
      connectedServicesUpdatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

function normalizeBindingForSpawn(
  binding: ConnectedServiceBindingSelectionV1 | undefined,
): ConnectedServiceBindingSelectionV1 {
  if (binding?.source !== 'connected') return { source: 'native' };
  if (binding.selection === 'group') {
    return {
      source: 'connected',
      selection: 'group',
      groupId: binding.groupId,
    };
  }
  return {
    source: 'connected',
    selection: 'profile',
    profileId: binding.profileId,
  };
}

export function resolveSpawnConnectedServicesDefaults(params: Readonly<{
  accountSettings: unknown;
  agentId: AgentId;
}>): ConnectedServiceBindingsV1 | null {
  const supportedServiceIds = AGENTS_CORE[params.agentId].connectedServices?.supportedServiceIds ?? [];
  if (supportedServiceIds.length === 0) return null;

  const settingsRecord = params.accountSettings && typeof params.accountSettings === 'object' && !Array.isArray(params.accountSettings)
    ? params.accountSettings as { connectedServicesDefaultAuthByAgentIdV1?: unknown }
    : {};
  const parsedDefaults = ConnectedServicesDefaultAuthByAgentIdV1Schema.safeParse(
    settingsRecord.connectedServicesDefaultAuthByAgentIdV1,
  );
  if (!parsedDefaults.success) return null;

  const configuredBindings = parsedDefaults.data.bindingsByAgentId[params.agentId]?.bindingsByServiceId ?? {};
  const bindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV1> = {};
  let hasConnectedBinding = false;

  for (const serviceId of supportedServiceIds) {
    const binding = normalizeBindingForSpawn(configuredBindings[serviceId]);
    bindingsByServiceId[serviceId] = binding;
    if (binding.source === 'connected') {
      hasConnectedBinding = true;
    }
  }

  if (!hasConnectedBinding) return null;
  return ConnectedServiceBindingsV1Schema.parse({
    v: 1,
    bindingsByServiceId,
  });
}
