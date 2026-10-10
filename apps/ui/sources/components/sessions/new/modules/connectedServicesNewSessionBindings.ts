import {
  buildConnectedServiceAccountGroupOptionsByServiceId as buildSharedConnectedServiceAccountGroupOptionsByServiceId,
  buildConnectedServiceProfileOptionsByServiceId as buildSharedConnectedServiceProfileOptionsByServiceId,
  isConnectedServiceProfileOptionSelectable,
  isConnectedServiceProfileStatusSelectable,
  resolveAgentSupportedConnectedServiceIds,
  resolveConnectedServiceSessionSelection,
  type ConnectedServiceId,
  type ConnectedServicesAccountGroupOptionsByServiceId,
  type ConnectedServicesProfileOption,
  type ConnectedServicesProfileOptionsByServiceId,
} from '@happier-dev/agents';
import { ConnectedAccountServiceKeySchema, ConnectedServiceBindingSelectionV2Schema, ConnectedServiceBindingsV2Schema, type ConnectedServiceBindingSelectionV2, type ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type {
  SessionTeamCredentialBindingIntentV1,
  TeamCredentialResourceCatalogEntryV1,
} from '@happier-dev/protocol/teams';

import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';

export {
  buildSharedConnectedServiceProfileOptionsByServiceId as buildConnectedServiceProfileOptionsByServiceId,
  buildSharedConnectedServiceAccountGroupOptionsByServiceId as buildConnectedServiceAccountGroupOptionsByServiceId,
  isConnectedServiceProfileOptionSelectable,
  isConnectedServiceProfileStatusSelectable,
  resolveAgentSupportedConnectedServiceIds,
};

export type {
  ConnectedServicesAccountGroupOptionsByServiceId,
  ConnectedServicesProfileOption,
  ConnectedServicesProfileOptionsByServiceId,
};

/** Names only the Agent's admitted launch purposes; retained unrelated bindings carry no disclosure authority. */
export function projectSessionCredentialSignInPurposes(params: Readonly<{
  declarations: readonly Readonly<{ service: PluginContributionIdentityV1 }>[];
  bindings: ConnectedServiceBindingsV2 | null | undefined;
  resolveServiceTitle: (service: PluginContributionIdentityV1) => string;
  formatNativeTitle: (title: string) => string;
  suppressedServiceIds?: readonly string[];
}>): readonly string[] {
  const suppressed = new Set((params.suppressedServiceIds ?? [])
    .map(resolveQualifiedConnectedAccountServiceKey).filter((key): key is string => key !== null));
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const declaration of params.declarations) {
    const key = buildQualifiedPluginContributionKey(declaration.service);
    if (seen.has(key) || suppressed.has(key)) continue;
    seen.add(key);
    const binding = params.bindings?.bindingsByServiceId[key];
    // Brokered use does not deliver the upstream reusable sign-in to this Machine.
    if (binding?.source === 'team_resource' && binding.deliveryMode === 'brokered') continue;
    const title = params.resolveServiceTitle(declaration.service);
    labels.push(!binding || binding.source === 'native' ? params.formatNativeTitle(title) : title);
  }
  return labels;
}

export function buildConnectedServicesBindingsPayload(params: Readonly<{
  /** Qualified keys on current callers; released bundled scalar ids are translated through the generated built-in mapping. */
  supportedConnectedServiceIds: ReadonlyArray<string>;
  connectedServiceProfileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId;
  connectedServiceAccountGroupOptionsByServiceId?: ConnectedServicesAccountGroupOptionsByServiceId;
  connectedServicesBindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
  defaultProfileByServiceId: Record<string, string | undefined>;
  accountGroupsFeatureEnabled?: boolean;
  /** Existing-session switches must publish native-only payloads to disconnect. */
  emitWhenAllNative?: boolean;
}>): ConnectedServiceBindingsV2 | null {
  const bindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV2> = {};
  const handledServiceIds = new Set<string>();
  let connectedCount = 0;
  let hasExplicitNativeBinding = false;

  for (const requestedServiceId of params.supportedConnectedServiceIds) {
    // The wire contract carries canonical qualified keys only. Resolve every
    // declared service through the provenance-named legacy ingress and drop
    // anything unknown — never emit a bare local id.
    const serviceId = resolveQualifiedConnectedAccountServiceKey(requestedServiceId);
    if (!serviceId || handledServiceIds.has(serviceId)) continue;
    handledServiceIds.add(serviceId);
    const options = params.connectedServiceProfileOptionsByServiceId[serviceId]
      ?? params.connectedServiceProfileOptionsByServiceId[requestedServiceId]
      ?? [];
    const binding = params.connectedServicesBindingsByServiceId[serviceId]
      ?? params.connectedServicesBindingsByServiceId[requestedServiceId];
    if (binding?.source === 'native') hasExplicitNativeBinding = true;
    if (binding?.source === 'team_resource') {
      bindingsByServiceId[serviceId] = binding;
      connectedCount += 1;
      continue;
    }
    const resolution = resolveConnectedServiceSessionSelection({
      serviceId,
      binding: binding ?? { source: 'native' },
      availability: {
        kind: 'known',
        profileOptions: options,
        groupOptions: params.connectedServiceAccountGroupOptionsByServiceId?.[serviceId]
          ?? params.connectedServiceAccountGroupOptionsByServiceId?.[requestedServiceId]
          ?? [],
        accountGroupsEnabled: params.accountGroupsFeatureEnabled !== false,
      },
      defaultProfileByServiceId: params.defaultProfileByServiceId,
    });

    if (resolution.status !== 'no_selection') {
      bindingsByServiceId[serviceId] = {
        source: 'connected',
        ...resolution.selection,
      };
      connectedCount += 1;
      continue;
    }

    bindingsByServiceId[serviceId] = { source: 'native' };
  }

  // A current Agent declaration governs what the picker may offer, not whether
  // a previously authored canonical binding still belongs to the controlled
  // value. Preserve valid qualified entries that are no longer declared so an
  // edit to one visible service cannot erase an unrelated stored choice.
  for (const [serviceId, binding] of Object.entries(params.connectedServicesBindingsByServiceId)) {
    if (handledServiceIds.has(serviceId)) continue;
    if (!ConnectedAccountServiceKeySchema.safeParse(serviceId).success) continue;
    const parsedBinding = ConnectedServiceBindingSelectionV2Schema.safeParse(binding);
    if (!parsedBinding.success) continue;
    bindingsByServiceId[serviceId] = parsedBinding.data;
    if (parsedBinding.data.source !== 'native') connectedCount += 1;
    else hasExplicitNativeBinding = true;
  }

  return connectedCount > 0 || hasExplicitNativeBinding || params.emitWhenAllNative === true
    ? ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId })
    : null;
}

/**
 * The Session Team slot bindings a New Session is created with: one
 * `connected_service_purpose` intent per declared purpose whose launch
 * selection is a Team resource the target Home currently offers, at that
 * resource's current revision. The selection may come from this draft or from
 * the Agent's durable purpose default; the Home admits either the same way.
 */
export function composeConnectedServiceTeamCredentialBindingIntents(params: Readonly<{
  consumer: PluginContributionIdentityV1;
  declarations: ReadonlyArray<Readonly<{ purpose: string; service: PluginContributionIdentityV1 }>>;
  bindings: ConnectedServiceBindingsV2;
  resources: readonly TeamCredentialResourceCatalogEntryV1[];
}>): SessionTeamCredentialBindingIntentV1[] {
  const intents: SessionTeamCredentialBindingIntentV1[] = [];
  for (const declaration of params.declarations) {
    const serviceId = buildQualifiedPluginContributionKey(declaration.service);
    const selection = params.bindings.bindingsByServiceId[serviceId];
    if (selection?.source !== 'team_resource') continue;
    const resource = params.resources.find((candidate) => (
      candidate.id === selection.resourceId
      && candidate.readiness.kind === 'available'
      && candidate.connectedServiceSelections.some((candidateSelection) => (
        candidateSelection.resourceId === selection.resourceId
        && candidateSelection.deliveryMode === selection.deliveryMode
        && JSON.stringify(candidateSelection.disclosedMember ?? null)
          === JSON.stringify(selection.disclosedMember ?? null)
      ))
    ));
    if (!resource) continue;
    intents.push({
      v: 1,
      slot: {
        kind: 'connected_service_purpose',
        purpose: { consumer: params.consumer, purpose: declaration.purpose },
      },
      resourceId: resource.id,
      expectedResourceRevision: resource.resourceRevision,
      deliveryMode: selection.deliveryMode,
    });
  }
  return intents;
}
