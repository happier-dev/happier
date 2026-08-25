import {
  isQualifiedConnectedAccountProfileActiveV4,
  resolveQualifiedConnectedAccountGroupActiveAccountV4,
  sameQualifiedConnectedAccountRef,
  type PluginConnectedAccountAuthenticationModeV2,
  type PluginContributionIdentityV1,
  type QualifiedConnectedAccountGroupV4,
  type QualifiedConnectedAccountProfileV4,
  type QualifiedConnectedAccountPurposeBindingTargetV1,
} from '@happier-dev/protocol';

import { isConnectedAccountConfigurationBlocked } from './configurationReadiness';

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
  resolveAuthenticationMode: (
    account: QualifiedConnectedAccountProfileV4,
  ) => PluginConnectedAccountAuthenticationModeV2 | null;
}>): ConnectedAccountPurposeTargetEligibility {
  const target = input.target;
  const now = Date.now();
  // One account readiness rule for both target kinds. A group resolves to an
  // exact account, so offering the group without applying the same
  // descriptor/configuration test would persist a target the daemon rejects at
  // materialization time.
  const resolveAccountEligibility = (
    account: QualifiedConnectedAccountProfileV4,
  ): ConnectedAccountPurposeTargetEligibility => {
    const authenticationMode = input.resolveAuthenticationMode(account);
    if (!authenticationMode) return 'unknown';
    return isConnectedAccountConfigurationBlocked({ account, authenticationMode })
      ? 'unusable'
      : 'usable';
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
    if (!account || !isQualifiedConnectedAccountProfileActiveV4(account, now)) return 'unusable';
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
  // The protocol resolver stays the sole owner of member/active/expiry policy.
  const activeAccount = resolveQualifiedConnectedAccountGroupActiveAccountV4({
    group,
    accounts: input.accounts,
    now,
  });
  return activeAccount ? resolveAccountEligibility(activeAccount) : 'unusable';
}
