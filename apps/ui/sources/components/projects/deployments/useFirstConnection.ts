import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { connectedAccountPurposeServiceTargets } from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useProfile } from '@/sync/store/hooks';

/**
 * A credential choice the Account cannot make yet: it has no account at all for `service` (unknown until its
 * inventory is read). `connect` runs the one shared Connect flow and hands the new account to `onConnected`.
 */
export function useFirstConnection(
  lifetime: ServerAccountScopeLifetime,
  service: PluginContributionIdentityV1 | null,
  onConnected: (account: QualifiedConnectedAccountRef) => void,
) {
  const accountId = lifetime.scope.accountId;
  const hasServiceAccount = useProfile((profile) =>
    profile.id !== accountId || !service
      ? null
      : connectedAccountPurposeServiceTargets(
          profile.connectedAccountsV4 ?? [],
          [],
          service,
        ).accounts.length > 0,
  );
  const connect = async () => {
    if (!service) return;
    const result = await presentConnectSheet({
      scope: lifetime.scope,
      service,
      intent: 'add',
    });
    if (result.kind === 'dismissed' || !lifetime.isCurrent()) return;
    onConnected(result.account);
  };
  return { missing: hasServiceAccount === false, connect };
}
