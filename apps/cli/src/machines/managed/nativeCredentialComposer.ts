import type { ManagedCredentialDeliveryResultV1, ManagedCredentialInstallInputV1, ManagedNativeCredentialBindingV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedCredentialDeliveryFailureCodeV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineProvisionerNativeCredentialApplyResultV1Schema, type MachineProvisionerNativeCredentialBindingV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { normalizeProviderPublicHeaders } from '@happier-dev/protocol/providers/credential-headers';
import type { RuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import type { TeamCredentialNativeProviderSource } from '@/providers/broker/teamCredentialNativeProviderSource';
import { projectTeamCredentialNativeRequestMatchesV1 } from '@/providers/broker/requestPolicyV1';
import { renderProviderProbeCredential } from '@/providers/spawn/runtimeCredential';
import { ManagedMachineNativeRefusal } from './controllerErrors';
import type { createManagedNativeInvocation } from './reconcile';

export type ComposeManagedNativeCredentialsInput = Readonly<{
  request: ManagedCredentialInstallInputV1;
  machine: ManagedMachineV1;
  /** Home-qualified owned census; its producer excludes unrelated prepared rows. */
  bindings: readonly ManagedNativeCredentialBindingV1[];
  /** Home's current-use classification, distinct from retained rule ownership. */
  desiredBindingKeys: readonly string[];
  prepareSource: RuntimeProviderModelManagementServices['prepareTeamCredentialNativeSource'];
  invoke: ReturnType<typeof createManagedNativeInvocation<true>>['invoke'];
  signal?: AbortSignal;
}>;

const refused = (code: string = 'provider_authorization_changed'): Extract<ManagedCredentialDeliveryResultV1, { kind: 'refused' }> => {
  const parsed = ManagedCredentialDeliveryFailureCodeV1Schema.safeParse(code);
  return { kind: 'refused', code: parsed.success ? parsed.data : 'provider_unavailable' };
};
const unknown = (): Extract<ManagedCredentialDeliveryResultV1, { kind: 'unknown' }> => ({ kind: 'unknown', code: 'action_outcome_unknown' });

function describeBinding(binding: ManagedNativeCredentialBindingV1, machine: ManagedMachineV1,
  controller: NonNullable<ManagedMachineV1['controller']>): MachineProvisionerNativeCredentialBindingV1 | null {
  const { safeFacet, delivery, providerModelSelection: selected } = binding;
  const { model, providerAuthorizationTicket: ticket, endpoint, credentialTransport } = delivery;
  if (binding.managedId !== machine.id || safeFacet.managedId !== machine.id
    || binding.custodianAccountId !== machine.custodianAccountId
    || safeFacet.controllerInstallationId !== controller.installationId
    || !pluginJsonValuesEqual(safeFacet, delivery.safeFacet)
    || ticket.machineId !== controller.machineId
    || !machine.enrolledMachineId || selected.executionMachineId !== machine.enrolledMachineId
    || !selected.application || !selected.nativeSource
    || selected.nativeSource.sourceRevision !== safeFacet.sourceRevision
    || selected.nativeSource.providerTicket !== safeFacet.providerTicket
    || model.selection.deliveryMode !== 'vendor-native' || model.selection.resourceId !== binding.resourceId
    || model.selection.expectedResourceRevision !== binding.resourceRevision
    || model.selection.agentTargetKey !== selected.agentTargetKey || model.selection.modelId !== selected.modelId
    || model.descriptor.id !== selected.modelId || !pluginJsonValuesEqual(model.application, selected.application)
    || model.sourceRevision !== safeFacet.sourceRevision || model.nativeSource?.providerTicket !== safeFacet.providerTicket
    || selected.application.agentTargetKey !== selected.agentTargetKey
    || selected.application.endpointTemplateId !== endpoint.endpointTemplateId || selected.application.protocol !== endpoint.protocol
    || credentialTransport.destination.kind !== 'httpHeader' || credentialTransport.additionalCredentials?.length) return null;
  const requests = projectTeamCredentialNativeRequestMatchesV1(endpoint);
  if (!requests) return null;
  const placeholder = renderProviderProbeCredential(delivery.placeholder, credentialTransport);
  if (placeholder.kind !== 'httpHeader') return null;
  // Observational, opaque existing identities; never a billing identity or an
  // authentication claim. The vendor transform overwrites caller attribution.
  const attribution = normalizeProviderPublicHeaders({ 'x-happier-attribution': JSON.stringify([binding.accountId, binding.sessionId]) });
  return { bindingKey: safeFacet.bindingKey, destination: endpoint.normalizedUrl, requests,
    placeholder: { header: placeholder.name, value: placeholder.value },
    attributionHeaders: Object.entries(attribution).map(([name, value]) => ({ name, value })) };
}

/** Replaces one resource's policy from the controller's current binding census.
 * The installed controller serializes this read/compose/apply; this function
 * keeps no independent desired state or vendor-policy reconstruction. */
export async function composeManagedNativeCredentials(input: ComposeManagedNativeCredentialsInput): Promise<ManagedCredentialDeliveryResultV1> {
  const { request, machine } = input;
  if (machine.id !== request.managedId || machine.homeId !== request.homeId) return refused();
  const target = input.bindings.find(binding => binding.safeFacet.bindingKey === request.bindingKey);
  if (!target || target.sessionId !== request.sessionId || target.resourceRevision !== request.expectedResourceRevision
    || target.safeFacet.sourceRevision !== request.expectedSourceRevision || target.safeFacet.providerTicket !== request.expectedProviderTicket
    || input.desiredBindingKeys.includes(target.safeFacet.bindingKey) === (request.operation === 'release')) return refused();
  const result = await applyManagedNativeCredentialPolicy(input);
  return result.kind === 'confirmed' ? { kind: 'confirmed', binding: target.safeFacet } : result;
}

/** The same whole-policy owner also converges an empty census after FK cascade. */
export async function applyManagedNativeCredentialPolicy(input: Omit<ComposeManagedNativeCredentialsInput, 'request'>):
  Promise<Exclude<ManagedCredentialDeliveryResultV1, { kind: 'confirmed' }> | Readonly<{ kind: 'confirmed' }>> {
  const sources = new Map<string, TeamCredentialNativeProviderSource>();
  let issued = false;
  const compose = async (): Promise<Exclude<ManagedCredentialDeliveryResultV1, { kind: 'confirmed' }> | Readonly<{ kind: 'confirmed' }>> => {
    const { machine } = input;
    const controller = machine.controller;
    if (!machine.resource || !controller || input.signal?.aborted) return refused();
    const keys = new Set(input.bindings.map(binding => binding.safeFacet.bindingKey));
    const desiredKeys = new Set(input.desiredBindingKeys);
    if (keys.size !== input.bindings.length || desiredKeys.size !== input.desiredBindingKeys.length
      || input.desiredBindingKeys.some(key => !keys.has(key))) return refused();
    const bindings: MachineProvisionerNativeCredentialBindingV1[] = [];
    for (const binding of input.bindings) {
      if (!desiredKeys.has(binding.safeFacet.bindingKey)) continue;
      const descriptor = describeBinding(binding, machine, controller);
      if (!descriptor) return refused();
      const { delivery, providerModelSelection: selected } = binding;
      const prepared = await input.prepareSource({ machineId: controller.machineId,
        agentTargetKey: selected.agentTargetKey, sourceCatalog: true, refreshPolicy: 'current_only',
        currentSelection: { providerConnectionId: delivery.providerAuthorizationTicket.connectionId,
          agentTargetKey: selected.agentTargetKey, modelId: selected.modelId },
        application: selected.application, providerConnection: { connectionId: delivery.providerAuthorizationTicket.connectionId,
          expectedConnectionSecurityFingerprint: delivery.providerAuthorizationTicket.connectionSecurityFingerprint },
        nativeSource: { resourceId: binding.resourceId, expectedResourceRevision: binding.resourceRevision } }, input.signal);
      if (!prepared.ok) return refused(prepared.error.code);
      const source = prepared.source;
      sources.set(descriptor.bindingKey, source);
      const { resolvedAddresses: _dns, ...endpoint } = source.endpoint;
      if (!pluginJsonValuesEqual(source.authorizationTicket, delivery.providerAuthorizationTicket)
        || source.providerTicket !== binding.safeFacet.providerTicket || source.sourceRevision !== binding.safeFacet.sourceRevision
        || !pluginJsonValuesEqual(endpoint, delivery.endpoint) || !pluginJsonValuesEqual(source.credentialTransport, delivery.credentialTransport)) return refused();
      bindings.push(descriptor);
    }
    issued = true;
    const applied = MachineProvisionerNativeCredentialApplyResultV1Schema.safeParse(await input.invoke('nativeCredentialApply', {
      resource: machine.resource, baseline: { kind: 'allow-all' }, bindings, ownedBindings: bindings,
    }, { signal: input.signal, managedNativeCredentials: { role: 'nativeCredentialApply', bindings: sources } }));
    if (!applied.success) return unknown();
    if (applied.data.kind === 'refused') return refused(applied.data.code);
    if (applied.data.kind !== 'confirmed') return unknown();
    return { kind: 'confirmed' };
  };
  let result: Awaited<ReturnType<typeof compose>>;
  try { result = await compose(); }
  catch (error) { result = error instanceof ManagedMachineNativeRefusal ? refused(error.code) : issued ? unknown() : refused(); }
  // IO may have outlived local cancellation. Keep every source lease alive
  // until its invocation has settled and join all cleanup paths before return.
  const cleaned = await Promise.allSettled([...sources.values()].map(async source => await source.cleanup()));
  if (cleaned.some(cleanup => cleanup.status === 'rejected')) return issued ? unknown() : refused('provider_unavailable');
  return result;
}
