import { AGENTS_CORE, type AgentId } from '@happier-dev/agents';
import {
  ConnectedServicesDefaultAuthByAgentIdV1Schema,
  ConnectedServiceBindingsV1Schema,
  type ConnectedServiceBindingSelectionV1,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

export function agentSupportsSpawnConnectedServicesDefaults(agentId: AgentId): boolean {
  return (AGENTS_CORE[agentId].connectedServices?.supportedServiceIds.length ?? 0) > 0;
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
