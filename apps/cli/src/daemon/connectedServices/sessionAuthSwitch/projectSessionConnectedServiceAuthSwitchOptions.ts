import { applyProjectedCredentialKindRestrictions } from '@happier-dev/agents';
import type { AccountProfileResponse, ConnectedServiceBindingsV2, TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol';
import { isConnectedServiceCredentialHealthStatusUsable, normalizeConnectedServiceCredentialHealthStatus } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { SessionConnectedServiceAuthSwitchOption } from '@happier-dev/protocol/connect/sessionConnectedServiceAuthSwitch';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readTeamCredentialDeliveryReadinessV1 } from '@happier-dev/protocol/teams/credentials/deliveryV1';
import type { SessionTeamCredentialBindingIntentListV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { areTeamResourceConnectedServiceSelectionsEqual } from '@happier-dev/protocol/connect/connected-service-bindings';

import { resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import type { CatalogAgentId } from '@/agent/catalog/types';
import { projectAgentConnectedAccounts } from '@/plugins/projection/registry/projection/v2';
import { groupHasEnabledMember } from './switchSessionConnectedServiceAuth';

type Binding = ConnectedServiceBindingsV2['bindingsByServiceId'][string];

/** Project complete switch operands from the Session's current routing and Account catalogs. */
export function projectSessionConnectedServiceAuthSwitchOptions(input: Readonly<{
  agentId: CatalogAgentId;
  bindings: ConnectedServiceBindingsV2;
  profile: AccountProfileResponse;
  teamResources: readonly TeamCredentialResourceCatalogEntryV1[];
}>): SessionConnectedServiceAuthSwitchOption[] {
  const agent = readCurrentContributionRegistry().agentDefinitionsById.get(input.agentId);
  if (!agent?.identity) return [];
  const identity = agent.identity;
  const purposes = projectAgentConnectedAccounts(agent);
  const options: SessionConnectedServiceAuthSwitchOption[] = [];
  for (const serviceId of resolveCatalogAgentConnectedAccountServiceIds(input.agentId)) {
    const servicePurposes = purposes.filter(purpose => buildQualifiedPluginContributionKey(purpose.service) === serviceId);
    const bindingsByServiceId = input.bindings.bindingsByServiceId;
    const currentBinding = bindingsByServiceId[serviceId];
    const previousResource = currentBinding?.source === 'team_resource'
      ? input.teamResources.find(resource => resource.connectedServiceSelections.some(
        selection => areTeamResourceConnectedServiceSelectionsEqual(selection, currentBinding),
      )) : undefined;
    const intents = (binding: Binding | undefined, resource?: TeamCredentialResourceCatalogEntryV1): SessionTeamCredentialBindingIntentListV1 | undefined =>
      servicePurposes.length === 0 ? undefined : servicePurposes.map(declaration => ({
        v: 1,
        slot: { kind: 'connected_service_purpose', purpose: { consumer: identity, purpose: declaration.purpose } },
        ...(resource && binding?.source === 'team_resource'
          ? { resourceId: resource.id, expectedResourceRevision: resource.resourceRevision, deliveryMode: binding.deliveryMode }
          : { resourceId: null }),
      }));
    const previousTeamCredentialBindings = currentBinding?.source === 'team_resource' && !previousResource
      ? undefined : intents(currentBinding, previousResource);
    const add = (binding: Binding, label: string, operands: Pick<SessionConnectedServiceAuthSwitchOption['routing'],
      'expectedGroupGenerationByServiceId' | 'teamVisibilityGrantConsent'> = {},
      resource?: TeamCredentialResourceCatalogEntryV1) => {
      const teamCredentialBindings = intents(binding, resource);
      options.push({ label, routing: {
        agentId: input.agentId,
        selectedServiceId: serviceId,
        bindings: { v: 2, bindingsByServiceId: { ...bindingsByServiceId, [serviceId]: binding } },
        ...(teamCredentialBindings ? { teamCredentialBindings } : {}),
        ...(previousTeamCredentialBindings ? { previousTeamCredentialBindings } : {}),
        ...operands,
      } });
    };

    if (!currentBinding || currentBinding.source === 'native'
      || agent.richDefinition?.definition.capabilities?.connectedToNativeSwitchUnsupported !== true) {
      add({ source: 'native' }, 'Native sign-in');
    }
    const profiles = input.profile.connectedAccountsV4
      .filter(profile => buildQualifiedPluginContributionKey(profile.ref.service) === serviceId)
      .map(profile => ({
        profileId: profile.ref.accountId, status: normalizeConnectedServiceCredentialHealthStatus(profile.status),
        kind: profile.kind ?? null, label: profile.displayName ?? profile.ref.accountId,
      }));
    const projectedProfiles = applyProjectedCredentialKindRestrictions({
      optionsByServiceId: { [serviceId]: profiles }, connectedAccounts: servicePurposes,
    })[serviceId] ?? [];
    const eligibleProfiles = projectedProfiles.filter(profile =>
      profile.status !== 'unsupported_kind' && isConnectedServiceCredentialHealthStatusUsable(profile.status));
    const eligibleProfileIds = new Set(eligibleProfiles.map(profile => profile.profileId));
    for (const profile of eligibleProfiles) {
      add({ source: 'connected', selection: 'profile', profileId: profile.profileId }, profile.label ?? profile.profileId);
    }
    for (const group of input.profile.connectedAccountGroupsV4) {
      const active = group.activeConnectedAccountId;
      if (buildQualifiedPluginContributionKey(group.ref.service) !== serviceId || !active
        || !eligibleProfileIds.has(active) || !groupHasEnabledMember({ group, profileId: active })) continue;
      add({ source: 'connected', selection: 'group', groupId: group.ref.groupId },
        group.displayName ?? group.ref.groupId, { expectedGroupGenerationByServiceId: { [serviceId]: group.generation } });
    }
    if (servicePurposes.length === 0) continue;
    for (const resource of input.teamResources) {
      if (resource.sourcePresentation?.kind !== 'connected_service'
        || buildQualifiedPluginContributionKey(resource.sourcePresentation.service) !== serviceId) continue;
      for (const selection of resource.connectedServiceSelections) {
        if (readTeamCredentialDeliveryReadinessV1(resource.readiness, selection.deliveryMode).kind !== 'available') continue;
        add(selection, 'Team credential', resource.sessionUsePolicy === 'team_visibility_required'
          ? { teamVisibilityGrantConsent: { teamId: resource.teamId } } : {}, resource);
      }
    }
  }
  return options;
}
