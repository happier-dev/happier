import type { ProviderBrokerApplicationBindingV1, ProviderWireProtocol, ResolvedProviderManagedRuntimeDeclarationV1 } from '@happier-dev/protocol';
import type { ProviderBrokerSourceApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { projectApplicationEndpoint, projectAgentProviderBrokerApplications as projectDeclaredAgentProviderBrokerApplications } from '@happier-dev/protocol/providers/catalog/brokerApplicationProjectionV1';
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

/** Exact managed implementation admission uses the current contribution, never
 * a retained identity or a host copy of plugin endpoint/protocol facts. */
type ManagedApplicationInput = Readonly<{
  registry: ProviderContributionRegistryView;
  implementationIdentity: ProviderBrokerApplicationBindingV1['implementationIdentity'];
  agentTargetKey?: string;
  protocol: ProviderWireProtocol;
  endpointTemplateId?: string;
}>;
export function projectManagedProviderBrokerApplication(input: ManagedApplicationInput & { agentTargetKey: string }): ProviderBrokerApplicationBindingV1 | null;
export function projectManagedProviderBrokerApplication(input: ManagedApplicationInput): ProviderBrokerSourceApplicationBindingV1 | null;
export function projectManagedProviderBrokerApplication(input: ManagedApplicationInput): ProviderBrokerSourceApplicationBindingV1 | null {
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

/** Enumerates declared managed applications for the worker's accepted protocols.
 * This is catalog composition only; source projection still owns model
 * membership, compatibility and availability. */
export function projectAgentProviderBrokerApplications(input: Readonly<{
  registry: ProviderContributionRegistryView;
  agentTargetKey: string;
  acceptedProtocols: readonly ProviderWireProtocol[];
}>): readonly ProviderBrokerApplicationBindingV1[] {
  return projectDeclaredAgentProviderBrokerApplications({
    providers: [...input.registry.providersByContributionKey.values()],
    agentTargetKey: input.agentTargetKey,
    acceptedProtocols: input.acceptedProtocols,
  });
}

export function resolveManagedProviderBrokerPurpose(input: Readonly<{
  registry: ProviderContributionRegistryView;
  application: ProviderBrokerSourceApplicationBindingV1;
  service: ResolvedProviderManagedRuntimeDeclarationV1['connectedAccounts'][number]['service'];
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
  const purposes = runtime.connectedAccounts.filter((purpose) =>
    purpose.service.pluginId === input.service.pluginId
    && purpose.service.localId === input.service.localId
    && purpose.endpointTemplateIds?.includes(input.application.endpointTemplateId));
  return purposes.length === 1 ? purposes[0]! : null;
}

/**
 * Projects the exact executable application from the current resolved Provider
 * owner. Callers never infer endpoint ids or implementation identities from a
 * model id or a persisted Team source binding.
 */
type ProviderApplicationInput = Readonly<{
  connection: ResolvedProviderConnectionRecord;
  agentTargetKey?: string;
  protocol: ProviderWireProtocol;
  expectedApplication?: ProviderBrokerSourceApplicationBindingV1;
}>;
export function projectProviderBrokerApplication(input: ProviderApplicationInput & { agentTargetKey: string }): ProviderBrokerApplicationBindingV1 | null;
export function projectProviderBrokerApplication(input: ProviderApplicationInput): ProviderBrokerSourceApplicationBindingV1 | null;
export function projectProviderBrokerApplication(input: ProviderApplicationInput): ProviderBrokerSourceApplicationBindingV1 | null {
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
