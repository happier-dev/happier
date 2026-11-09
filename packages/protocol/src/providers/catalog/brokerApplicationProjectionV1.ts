import type { ProviderBrokerApplicationBindingV1, ProviderBrokerSourceApplicationBindingV1 } from '../brokerRouteGrantV1.js';
import type { ProviderWireProtocol } from '../capabilities/v1.js';
import type { ProviderContributionV1, ProviderEndpointTemplateV1 } from '../contributions/v1.js';

/** Projects only an admitted declaration's endpoint and managed-runtime membership. */
type ApplicationEndpointInput = Readonly<{
  implementationIdentity: ProviderBrokerApplicationBindingV1['implementationIdentity'];
  agentTargetKey?: string;
  protocol: ProviderWireProtocol;
  endpointTemplates: readonly ProviderEndpointTemplateV1[];
  managedEndpointTemplateIds?: readonly string[];
  endpointTemplateId?: string;
}>;
export function projectApplicationEndpoint(input: ApplicationEndpointInput & { agentTargetKey: string }): ProviderBrokerApplicationBindingV1 | null;
export function projectApplicationEndpoint(input: ApplicationEndpointInput): ProviderBrokerSourceApplicationBindingV1 | null;
export function projectApplicationEndpoint(input: ApplicationEndpointInput): ProviderBrokerSourceApplicationBindingV1 | null {
  const endpoint = input.endpointTemplates.find(candidate => (
    candidate.protocol === input.protocol
    && (input.endpointTemplateId === undefined || candidate.id === input.endpointTemplateId)
    && (input.managedEndpointTemplateIds === undefined || input.managedEndpointTemplateIds.includes(candidate.id))
  ));
  return endpoint ? {
    ...(input.agentTargetKey === undefined ? {} : { agentTargetKey: input.agentTargetKey }),
    implementationIdentity: input.implementationIdentity,
    endpointTemplateId: endpoint.id,
    protocol: endpoint.protocol,
  } : null;
}

/** Declaration-only composition; the caller supplies its admitted Provider authority. */
export function projectAgentProviderBrokerApplications(input: Readonly<{
  providers: readonly Readonly<{
    identity: ProviderBrokerApplicationBindingV1['implementationIdentity'];
    definition: ProviderContributionV1;
  }>[];
  agentTargetKey: string;
  acceptedProtocols: readonly ProviderWireProtocol[];
}>): readonly ProviderBrokerApplicationBindingV1[] {
  return input.providers.flatMap(provider => {
    const managedRuntime = provider.definition.managedRuntime;
    if (!managedRuntime) return [];
    return provider.definition.endpointTemplates.flatMap(endpoint => {
        if (!input.acceptedProtocols.includes(endpoint.protocol)) return [];
        const application = projectApplicationEndpoint({
          agentTargetKey: input.agentTargetKey,
          protocol: endpoint.protocol,
          endpointTemplateId: endpoint.id,
          implementationIdentity: provider.identity,
          endpointTemplates: provider.definition.endpointTemplates,
          managedEndpointTemplateIds: managedRuntime.endpointTemplateIds,
        });
        return application ? [application] : [];
      });
  });
}
