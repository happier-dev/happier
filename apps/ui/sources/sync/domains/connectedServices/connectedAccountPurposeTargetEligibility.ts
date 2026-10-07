import { isQualifiedConnectedAccountProfileActiveV4, isQualifiedConnectedAccountProfileUsableV4, resolveQualifiedConnectedAccountGroupActiveAccountV4, type QualifiedConnectedAccountGroupV4, type QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { PluginConnectedAccountAuthenticationV2 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { TeamResourceConnectedServiceSelectionV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';

import { areTeamResourceConnectedServiceSelectionsEqual } from './connectedServicesAgentOptionStateBindings';

function sameService(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

/**
 * Canonical passive target eligibility for every Connected Accounts consumer.
 *
 * `unknown` means descriptor/authentication-mode truth is incomplete. It is
 * deliberately non-selectable rather than a reason to reinterpret a current
 * binding as absent or to ask a legacy service path for a replacement.
 */
export type ConnectedAccountPurposeTargetEligibility = 'usable' | 'unusable' | 'unknown';

export function resolveConnectedAccountPurposeTargetEligibility(input: Readonly<{
  target: QualifiedConnectedAccountPurposeBindingTargetV1;
  declaredServices: readonly PluginContributionIdentityV1[];
  accounts: readonly QualifiedConnectedAccountProfileV4[];
  groups: readonly QualifiedConnectedAccountGroupV4[];
  resolveAuthentication: (
    service: PluginContributionIdentityV1,
  ) => PluginConnectedAccountAuthenticationV2 | null;
}>): ConnectedAccountPurposeTargetEligibility {
  const target = input.target;
  const now = Date.now();
  // One descriptor-aware Protocol rule serves both target kinds. The UI retains
  // only the incomplete-descriptor state; it must not reconstruct mode or
  // configuration policy from a local projection.
  const resolveAccountEligibility = (
    account: QualifiedConnectedAccountProfileV4,
  ): ConnectedAccountPurposeTargetEligibility => {
    if (!isQualifiedConnectedAccountProfileActiveV4(account, now)) {
      return 'unusable';
    }
    const authentication = input.resolveAuthentication(account.ref.service);
    if (!authentication) return 'unknown';
    return isQualifiedConnectedAccountProfileUsableV4({
      profile: account,
      authentication,
      now,
    }) ? 'usable' : 'unusable';
  };
  if (target.kind === 'account') {
    const accountTarget = target.account;
    if (!input.declaredServices.some((candidate) => sameService(candidate, accountTarget.service))) {
      return 'unusable';
    }
    const account = input.accounts.find((candidate) => sameQualifiedConnectedAccountRef(
      candidate.ref,
      accountTarget,
    ));
    if (!account) return 'unusable';
    return resolveAccountEligibility(account);
  }
  const service = target.service;
  const groupId = target.groupId;
  if (!input.declaredServices.some((candidate) => sameService(candidate, service))) return 'unusable';
  const group = input.groups.find((candidate) => (
    sameService(candidate.ref.service, service)
    && candidate.ref.groupId === groupId
  ));
  if (!group) return 'unusable';
  const authentication = input.resolveAuthentication(service);
  if (!authentication) return 'unknown';
  // The Protocol resolver stays the sole owner of member, active, expiry, and
  // descriptor configuration policy for a group.
  const activeAccount = resolveQualifiedConnectedAccountGroupActiveAccountV4({
    group,
    accounts: input.accounts,
    authentication,
    now,
  });
  return activeAccount ? 'usable' : 'unusable';
}

/**
 * A Team resource purpose default is usable only while the viewer's entitled
 * Team catalog still offers this exact selection on an available resource of
 * the declared service. Absence (catalog not supplied, resource withdrawn) is
 * never a personal fallback (lane 10 child 02 §11.6).
 */
export function resolveConnectedAccountPurposeTeamResourceEligibility(input: Readonly<{
  teamResource: Readonly<{ teamId: string; selection: TeamResourceConnectedServiceSelectionV2 }>;
  service: PluginContributionIdentityV1;
  teamResources: readonly TeamCredentialResourceCatalogEntryV1[];
}>): ConnectedAccountPurposeTargetEligibility {
  const { teamResource } = input;
  const resource = input.teamResources.find((candidate) => (
    candidate.id === teamResource.selection.resourceId && candidate.teamId === teamResource.teamId
  ));
  return resource?.readiness.kind === 'available'
    && resource.sourcePresentation?.kind === 'connected_service'
    && sameService(resource.sourcePresentation.service, input.service)
    && resource.connectedServiceSelections.some((selection) => (
      areTeamResourceConnectedServiceSelectionsEqual(selection, teamResource.selection)
    ))
    ? 'usable'
    : 'unusable';
}
