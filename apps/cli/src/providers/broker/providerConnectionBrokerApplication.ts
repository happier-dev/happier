import type { ProviderBrokerApplicationBindingV1, ProviderWireProtocol } from '@happier-dev/protocol';
import type { ProviderBrokerSourceApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import { getProviderContribution } from '@/providers/registry';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';

import { projectManagedProviderBrokerApplication } from './applicationProjection';

/** Exact requests admit their declared implementation without a catalog scan.
 * Discovery requires a unique declaration because it has no selected identity. */
export function readProviderConnectionBrokerImplementation(
  registry: ProviderContributionRegistryView,
  implementationIdentity?: ProviderBrokerApplicationBindingV1['implementationIdentity'],
): ResolvedProviderContribution | null {
  if (implementationIdentity) {
    const provider = getProviderContribution(registry,
      `${implementationIdentity.pluginId}/${implementationIdentity.localId}`);
    return provider?.definition.managedRuntime?.sourceEnvelopeTransport === 'cpx-v1' ? provider : null;
  }
  let implementation: ResolvedProviderContribution | null = null;
  for (const provider of registry.providersByContributionKey.values()) {
    if (provider.definition.managedRuntime?.sourceEnvelopeTransport !== 'cpx-v1') continue;
    if (implementation) return null;
    implementation = provider;
  }
  return implementation;
}

/** The signed downstream application describes the member-facing protocol.
 * A saved Provider Connection supplies the independent upstream endpoint. */
type BrokerApplicationInput = Readonly<{
  registry: ProviderContributionRegistryView;
  agentTargetKey?: string;
  protocol: ProviderWireProtocol;
  expectedApplication?: ProviderBrokerSourceApplicationBindingV1;
}>;
export function projectProviderConnectionBrokerApplication(input: BrokerApplicationInput & { agentTargetKey: string }): ProviderBrokerApplicationBindingV1 | null;
export function projectProviderConnectionBrokerApplication(input: BrokerApplicationInput): ProviderBrokerSourceApplicationBindingV1 | null;
export function projectProviderConnectionBrokerApplication(input: BrokerApplicationInput): ProviderBrokerSourceApplicationBindingV1 | null {
  const identity = readProviderConnectionBrokerImplementation(input.registry,
    input.expectedApplication?.implementationIdentity)?.identity;
  if (!identity) return null;
  if (input.expectedApplication && (
    input.expectedApplication.implementationIdentity.pluginId !== identity.pluginId
    || input.expectedApplication.implementationIdentity.localId !== identity.localId
    || input.expectedApplication.agentTargetKey !== input.agentTargetKey
    || input.expectedApplication.protocol !== input.protocol
  )) return null;
  return projectManagedProviderBrokerApplication({
    registry: input.registry,
    implementationIdentity: identity,
    agentTargetKey: input.agentTargetKey,
    protocol: input.protocol,
    ...(input.expectedApplication ? { endpointTemplateId: input.expectedApplication.endpointTemplateId } : {}),
  });
}

/** Returns the declared consumer base after exact application admission. */
export function resolveProviderConnectionBrokerDownstreamUrl(
  registry: ProviderContributionRegistryView,
  application: ProviderBrokerSourceApplicationBindingV1,
): string | null {
  const projected = projectProviderConnectionBrokerApplication({
    registry, agentTargetKey: application.agentTargetKey, protocol: application.protocol,
    expectedApplication: application,
  });
  if (!projected) return null;
  const implementation = getProviderContribution(registry,
    `${projected.implementationIdentity.pluginId}/${projected.implementationIdentity.localId}`);
  const endpoint = implementation?.definition.endpointTemplates.find(
    candidate => candidate.id === projected.endpointTemplateId,
  );
  return endpoint?.baseUrl ?? endpoint?.localUrlCandidates?.[0] ?? null;
}
