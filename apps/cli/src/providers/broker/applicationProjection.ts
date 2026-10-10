import type { ProviderBrokerApplicationBindingV1, ProviderWireProtocol, ProviderEndpointTemplateV1, ResolvedProviderManagedRuntimeDeclarationV1 } from '@happier-dev/protocol';
import { resolveProviderManagedRuntimeDeclarationV1 } from '@happier-dev/protocol/providers/contributions';

import { getProviderContribution, type ProviderContributionRegistryView, type ResolvedProviderConnectionRecord } from '@/providers/registry';
import type { ProviderConnectionId } from '@happier-dev/protocol';
import { DaemonProviderModelProjectionRequestV1Schema, type DaemonProviderModelProjectionRequestV1 } from '@happier-dev/protocol/rpc/providers';

/** A personal connection reads its own application, never the Team credential
 * Provider-Connection adapter's distinct broker executable projection. */
export function createAccountConnectionModelProjectionRequest(input: Readonly<{
  machineId: string;
  connectionId: ProviderConnectionId;
  expectedConnectionSecurityFingerprint: string;
  agentTargetKey: string;
  application?: ProviderBrokerApplicationBindingV1;
  refreshPolicy?: 'current_only';
}>): DaemonProviderModelProjectionRequestV1 {
  return DaemonProviderModelProjectionRequestV1Schema.parse({
    machineId: input.machineId, agentTargetKey: input.agentTargetKey, mode: 'management',
    includeDirectMaterialization: true,
    providerConnection: { connectionId: input.connectionId,
      expectedConnectionSecurityFingerprint: input.expectedConnectionSecurityFingerprint },
    ...(input.application ? { application: input.application } : {}),
    ...(input.refreshPolicy ? { refreshPolicy: input.refreshPolicy } : {}),
  });
}

function projectApplicationEndpoint(input: Readonly<{
  implementationIdentity: ProviderBrokerApplicationBindingV1['implementationIdentity'];
  agentTargetKey: string;
  protocol: ProviderWireProtocol;
  endpointTemplates: readonly ProviderEndpointTemplateV1[];
  managedEndpointTemplateIds?: readonly string[];
  endpointTemplateId?: string;
}>): ProviderBrokerApplicationBindingV1 | null {
  const endpoint = input.endpointTemplates.find((candidate) => (
    candidate.protocol === input.protocol
    && (input.endpointTemplateId === undefined || candidate.id === input.endpointTemplateId)
    && (input.managedEndpointTemplateIds === undefined || input.managedEndpointTemplateIds.includes(candidate.id))
  ));
  return endpoint ? {
    agentTargetKey: input.agentTargetKey,
    implementationIdentity: input.implementationIdentity,
    endpointTemplateId: endpoint.id,
    protocol: endpoint.protocol,
  } : null;
}

/** Exact managed implementation admission uses the current contribution, never
 * a retained identity or a host copy of plugin endpoint/protocol facts. */
export function projectManagedProviderBrokerApplication(input: Readonly<{
  registry: ProviderContributionRegistryView;
  implementationIdentity: ProviderBrokerApplicationBindingV1['implementationIdentity'];
  agentTargetKey: string;
  protocol: ProviderWireProtocol;
  endpointTemplateId?: string;
}>): ProviderBrokerApplicationBindingV1 | null {
  const provider = getProviderContribution(input.registry,
    `${input.implementationIdentity.pluginId}/${input.implementationIdentity.localId}`);
  if (!provider?.definition.managedRuntime
    || provider.identity.pluginId !== input.implementationIdentity.pluginId
    || provider.identity.localId !== input.implementationIdentity.localId) return null;
  return projectApplicationEndpoint({
    agentTargetKey: input.agentTargetKey,
    protocol: input.protocol,
    ...(input.endpointTemplateId === undefined ? {} : { endpointTemplateId: input.endpointTemplateId }),
    implementationIdentity: provider.identity,
    endpointTemplates: provider.definition.endpointTemplates,
    managedEndpointTemplateIds: provider.definition.managedRuntime.endpointTemplateIds,
  });
}

export function resolveManagedProviderBrokerPurpose(input: Readonly<{
  registry: ProviderContributionRegistryView;
  application: ProviderBrokerApplicationBindingV1;
}>): ResolvedProviderManagedRuntimeDeclarationV1['connectedAccounts'][number] | null {
  if (!projectManagedProviderBrokerApplication({
    registry: input.registry,
    ...input.application,
  })) return null;
  const provider = getProviderContribution(input.registry,
    `${input.application.implementationIdentity.pluginId}/${input.application.implementationIdentity.localId}`)!;
  const runtime = resolveProviderManagedRuntimeDeclarationV1({
    implementationIdentity: provider.identity,
    managedRuntime: provider.definition.managedRuntime!,
  });
  return runtime.connectedAccounts.find((purpose) =>
    purpose.endpointTemplateIds?.includes(input.application.endpointTemplateId)) ?? null;
}

/**
 * Projects the exact executable application from the current resolved Provider
 * owner. Callers never infer endpoint ids or implementation identities from a
 * model id or a persisted Team source binding.
 */
export function projectProviderBrokerApplication(input: Readonly<{
  connection: ResolvedProviderConnectionRecord;
  agentTargetKey: string;
  protocol: ProviderWireProtocol;
  expectedApplication?: ProviderBrokerApplicationBindingV1;
}>): ProviderBrokerApplicationBindingV1 | null {
  const source = input.connection.source;
  if (source.kind !== 'contribution') return null;
  const identity = input.connection.deployment.kind === 'managedLocal'
    ? input.connection.deployment.implementationIdentity
    : { pluginId: source.pluginId, localId: source.definition.id };
  if (input.expectedApplication && (
    input.expectedApplication.agentTargetKey !== input.agentTargetKey
    || input.expectedApplication.protocol !== input.protocol
    || input.expectedApplication.implementationIdentity.pluginId !== identity.pluginId
    || input.expectedApplication.implementationIdentity.localId !== identity.localId
  )) return null;
  return projectApplicationEndpoint({
    agentTargetKey: input.agentTargetKey,
    implementationIdentity: identity,
    protocol: input.protocol,
    endpointTemplates: source.definition.endpointTemplates,
    ...(input.expectedApplication ? { endpointTemplateId: input.expectedApplication.endpointTemplateId } : {}),
    ...(input.connection.deployment.kind === 'managedLocal'
      ? { managedEndpointTemplateIds: input.connection.deployment.managedRuntime.endpointTemplateIds }
      : {}),
  });
}
