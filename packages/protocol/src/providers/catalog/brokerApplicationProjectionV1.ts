import type { ProviderBrokerApplicationBindingV1, ProviderBrokerSourceApplicationBindingV1 } from '../brokerRouteGrantV1.js';
import type { ProviderWireProtocol } from '../capabilities/v1.js';
import { resolveProviderConnectedAccountDeclarationsV1, type ProviderContributionV1, type ProviderEndpointTemplateV1 } from '../contributions/v1.js';

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

/** Declaration-only Team application demand. Exact source admission is owned by the broker. */
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
    const endpointIds = managedRuntime?.endpointTemplateIds
      ?? projectProviderRequestAuthBrokerPurposes(provider).flatMap(family => family.endpointTemplateIds ?? []);
    return provider.definition.endpointTemplates.flatMap(endpoint => {
      if (!input.acceptedProtocols.includes(endpoint.protocol) || !endpointIds.includes(endpoint.id)) return [];
      return [{
        agentTargetKey: input.agentTargetKey,
        implementationIdentity: provider.identity,
        endpointTemplateId: endpoint.id,
        protocol: endpoint.protocol,
      }];
    });
  });
}

/** A request-auth purpose with a declared broker endpoint can offer a qualified Account source. */
export function projectProviderRequestAuthBrokerPurposes(provider: Readonly<{
  identity: ProviderBrokerApplicationBindingV1['implementationIdentity'];
  definition: ProviderContributionV1;
}>) {
  if (provider.definition.managedRuntime) return [];
  const declarations = resolveProviderConnectedAccountDeclarationsV1(provider);
  const requestAuthPurposes = new Set(declarations.requestAuthUses.map(use => use.purpose));
  return declarations.connectedAccounts.filter(family =>
    family.endpointTemplateIds?.length && requestAuthPurposes.has(family.purpose));
}
