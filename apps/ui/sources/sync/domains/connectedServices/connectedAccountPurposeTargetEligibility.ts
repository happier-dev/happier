import { isQualifiedConnectedAccountProfileActiveV4, isQualifiedConnectedAccountProfileUsableV4, resolveQualifiedConnectedAccountGroupActiveAccountV4 } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { isConnectedAccountSignedOut } from './parseDisplayableCredentialHealthStatus';
import type { QualifiedConnectedAccountGroupV4, QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { PluginConnectedAccountAuthenticationV2 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { TeamResourceConnectedServiceSelectionV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';

import { resolveTeamResourceConnectedServiceSelectionV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { readTeamCredentialDeliveryReadinessV1 } from '@happier-dev/protocol/teams/credentials/readinessV1';

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

type TargetEligibilityInput = Readonly<{
  target: QualifiedConnectedAccountPurposeBindingTargetV1;
  declaredServices: readonly PluginContributionIdentityV1[];
  accounts: readonly QualifiedConnectedAccountProfileV4[];
  groups: readonly QualifiedConnectedAccountGroupV4[];
  resolveAuthentication: (
    service: PluginContributionIdentityV1,
  ) => PluginConnectedAccountAuthenticationV2 | null;
}>;

export type ConnectedAccountPurposeTargetEligibilityReason =
  | 'serviceUnavailable' | 'serviceLookupFailed' | 'targetMissing' | 'accountReconnect' | 'accountUnavailable'
  | 'poolEmpty' | 'poolNeedsActiveAccount';
type TargetEligibilityDescription =
  | Readonly<{ eligibility: 'usable'; reason: null }>
  | Readonly<{ eligibility: 'unusable' | 'unknown'; reason: ConnectedAccountPurposeTargetEligibilityReason }>;

export function resolveConnectedAccountPurposeTargetEligibility(input: TargetEligibilityInput): ConnectedAccountPurposeTargetEligibility {
  return describeConnectedAccountPurposeTargetEligibility(input).eligibility;
}

/** The passive decision and its repair reason are one fact for rows and choosers. */
export function describeConnectedAccountPurposeTargetEligibility(input: TargetEligibilityInput): TargetEligibilityDescription {
  const target = input.target;
  const now = Date.now();
  // One descriptor-aware Protocol rule serves both target kinds. The UI retains
  // only the incomplete-descriptor state; it must not reconstruct mode or
  // configuration policy from a local projection.
  const resolveAccountEligibility = (
    account: QualifiedConnectedAccountProfileV4,
  ): TargetEligibilityDescription => {
    if (!isQualifiedConnectedAccountProfileActiveV4(account, now)) {
      return { eligibility: 'unusable', reason: isConnectedAccountSignedOut(account.status) || (typeof account.expiresAt === 'number' && account.expiresAt <= now)
        ? 'accountReconnect' : 'accountUnavailable' };
    }
    const authentication = input.resolveAuthentication(account.ref.service);
    if (!authentication) return { eligibility: 'unknown', reason: 'serviceLookupFailed' };
    return isQualifiedConnectedAccountProfileUsableV4({
      profile: account,
      authentication,
      now,
    }) ? { eligibility: 'usable', reason: null } : { eligibility: 'unusable', reason: 'accountUnavailable' };
  };
  if (target.kind === 'account') {
    const accountTarget = target.account;
    if (!input.declaredServices.some((candidate) => sameService(candidate, accountTarget.service))) {
      return { eligibility: 'unusable', reason: 'serviceUnavailable' };
    }
    const account = input.accounts.find((candidate) => sameQualifiedConnectedAccountRef(
      candidate.ref,
      accountTarget,
    ));
    if (!account) return { eligibility: 'unusable', reason: 'targetMissing' };
    return resolveAccountEligibility(account);
  }
  const service = target.service;
  const groupId = target.groupId;
  if (!input.declaredServices.some((candidate) => sameService(candidate, service))) return { eligibility: 'unusable', reason: 'serviceUnavailable' };
  const group = input.groups.find((candidate) => (
    sameService(candidate.ref.service, service)
    && candidate.ref.groupId === groupId
  ));
  if (!group) return { eligibility: 'unusable', reason: 'targetMissing' };
  const authentication = input.resolveAuthentication(service);
  if (!authentication) return { eligibility: 'unknown', reason: 'serviceLookupFailed' };
  // The Protocol resolver stays the sole owner of member, active, expiry, and
  // descriptor configuration policy for a group.
  const activeAccount = resolveQualifiedConnectedAccountGroupActiveAccountV4({
    group,
    accounts: input.accounts,
    authentication,
    now,
  });
  return activeAccount ? { eligibility: 'usable', reason: null }
    : { eligibility: 'unusable', reason: group.members.length === 0 ? 'poolEmpty' : 'poolNeedsActiveAccount' };
}

/**
 * A Team resource purpose default is usable only while the viewer's entitled
 * Team catalog still offers this exact selection on an available delivery of
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
  if (!resource) return 'unusable';
  const readiness = readTeamCredentialDeliveryReadinessV1(resource.readiness, teamResource.selection.deliveryMode);
  // Available delivery requires an offered identity, not an unavailable source's retained diagnosis.
  return readiness.kind === 'available'
    && resolveTeamResourceConnectedServiceSelectionV1({ resource: { ...resource, readiness }, ...teamResource, services: [input.service] })
    ? 'usable'
    : 'unusable';
}
