import type {
  PluginConnectedAccountAuthenticationModeV2,
  PluginContributionIdentityV1,
  QualifiedConnectedAccountGroupV4,
  QualifiedConnectedAccountProfileV4,
  QualifiedConnectedAccountPurposeBindingTargetV1,
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
  if (target.kind === 'account') {
    const accountTarget = target.account;
    if (!input.declaredServices.some((candidate) => sameService(candidate, accountTarget.service))) {
      return 'unusable';
    }
    const account = input.accounts.find((candidate) => (
      sameService(candidate.ref.service, accountTarget.service)
      && candidate.ref.accountId === accountTarget.accountId
    ));
    if (
      account?.status !== 'connected'
      || account.revisionSemantics !== 'revisioned'
    ) return 'unusable';
    const authenticationMode = input.resolveAuthenticationMode(account);
    if (!authenticationMode) return 'unknown';
    return isConnectedAccountConfigurationBlocked({ account, authenticationMode })
      ? 'unusable'
      : 'usable';
  }
  const service = target.service;
  const groupId = target.groupId;
  if (!input.declaredServices.some((candidate) => sameService(candidate, service))) return 'unusable';
  return input.groups.some((group) => (
    sameService(group.ref.service, service)
    && group.ref.groupId === groupId
    && group.state.status === 'ready'
  )) ? 'usable' : 'unusable';
}
