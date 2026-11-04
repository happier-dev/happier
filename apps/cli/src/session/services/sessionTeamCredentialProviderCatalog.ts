import type { ActionExecutorDeps, ProviderBrokerApplicationBindingV1, TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol';
import type { TeamCredentialRouteV1 } from '@happier-dev/protocol/teams';

import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { readLeasedAgentProviderRequirements } from '@/plugins/runtime/providerBindings/adapter';
import { projectAgentProviderBrokerApplications } from '@/providers/broker/applicationProjection';
import { isSameTeamCredentialBrokerApplication } from '@/providers/broker/teamCredentialModelCatalog';
import { readSessionTeamCredentialResourceCatalog } from './sessionTeamCredentialCatalog';
import { SessionTeamCredentialLaunchUnavailableError } from './sessionTeamCredentialLaunchError';
import { readTeamCredentialLaunchReadinessRefusal } from './spawnConnectedServicesDefaults';

/** Discover the worker's applications once; exact revalidation reads only its selected application. */
export async function readSessionTeamCredentialProviderModels(input: Readonly<{
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  lease: PluginRuntimeRegistryLease;
  agentId: string;
  agentTargetKey: string;
  resourceId: string;
  executionMachineId?: string;
  teamId: string;
  deliveryMode: TeamCredentialRouteV1;
  application?: ProviderBrokerApplicationBindingV1;
  signal: AbortSignal;
}>): Promise<TeamCredentialResourceCatalogEntryV1['providerModels']> {
  const requirements = readLeasedAgentProviderRequirements(input);
  if (!requirements) throw new SessionTeamCredentialLaunchUnavailableError('agent_unavailable', 'agent_requirements');
  const supported = projectAgentProviderBrokerApplications({
    registry: input.lease.registry.contributes, agentTargetKey: input.agentTargetKey,
    acceptedProtocols: requirements.acceptsProtocols,
  });
  const application = input.application;
  const applications = application ? supported.filter(candidate => isSameTeamCredentialBrokerApplication(candidate, application)) : supported;
  if (application && applications.length === 0) {
    throw new SessionTeamCredentialLaunchUnavailableError('provider_incompatible_with_agent', 'agent_requirements');
  }
  const resources = await readSessionTeamCredentialResourceCatalog({
    homeDomainAction: input.homeDomainAction, applications, teamIds: [input.teamId], resourceId: input.resourceId, signal: input.signal,
    ...(input.executionMachineId ? { executionMachineId: input.executionMachineId } : {}),
  });
  const resource = resources.find(candidate => candidate.id === input.resourceId);
  if (resource) {
    const refusal = readTeamCredentialLaunchReadinessRefusal(resource, input.deliveryMode);
    if (refusal) throw new SessionTeamCredentialLaunchUnavailableError(refusal, 'readiness');
  }
  return resource?.providerModels ?? [];
}
