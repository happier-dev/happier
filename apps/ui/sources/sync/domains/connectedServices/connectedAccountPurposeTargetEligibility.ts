import {
  isQualifiedConnectedAccountProfileActiveV4,
  isQualifiedConnectedAccountProfileUsableV4,
  resolveQualifiedConnectedAccountGroupActiveAccountV4,
  sameQualifiedConnectedAccountRef,
  type PluginConnectedAccountAuthenticationV2,
  type PluginContributionIdentityV1,
  type QualifiedConnectedAccountGroupV4,
  type QualifiedConnectedAccountProfileV4,
  type QualifiedConnectedAccountPurposeBindingTargetV1,
} from '@happier-dev/protocol';

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
