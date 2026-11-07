import * as React from 'react';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useDeploymentInventory } from '@/components/projects/deployments/useDeploymentProject';
import { useDeploymentEnvironmentDomains } from '@/components/projects/deployments/useDeploymentReads';
import { projectMachineNetworkExposureFacts, type MachineNetworkExposureInput } from './networkExposureFacts';

const NO_ENVIRONMENTS: MachineNetworkExposureInput['environments'] = Object.freeze([]);

/** One Machine inventory page and one selected Environment's Domain page, shared with other visible consumers.
 * Continuations remain explicit. No inventory crawl or one request per service/Environment. */
export function useMachineNetworkExposure(input: Omit<MachineNetworkExposureInput, 'environments' | 'domains' | 'domainEnvironmentId'> & Readonly<{
  serverId: string; enabled: boolean; needsManage: boolean; environmentId?: string | null;
}>) {
  const { binding: lifetime } = useServerCredentialAccountScopeBinding(input.serverId);
  const active = input.enabled && !input.needsManage;
  const demand = React.useMemo(() => ({ mounted: active, visible: active, focused: active }), [active]);
  const inventory = useDeploymentInventory(lifetime, demand, { machineId: input.machineId });
  const environments = inventory.snapshot.value?.items ?? NO_ENVIRONMENTS;
  const environmentId = input.environmentId === undefined ? environments[0]?.environment.id ?? null : input.environmentId;
  const selected = environmentId && environments.some(item => item.environment.id === environmentId) ? environmentId : null;
  const domains = useDeploymentEnvironmentDomains(inventory.controller, selected, demand);
  const items = domains.snapshot.value?.items ?? null;
  const { posture, selections, observation, access } = input.facts;
  const facts = React.useMemo(() => projectMachineNetworkExposureFacts({ machineId: input.machineId,
    facts: { posture, selections, observation, access }, environments, domains: items, domainEnvironmentId: selected, services: input.services }),
  [input.machineId, posture, selections, observation, access, environments, items, selected, input.services]);
  return { facts, inventory, domains, environmentId: selected };
}
