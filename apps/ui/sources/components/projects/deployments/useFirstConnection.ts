import * as React from 'react';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { sameQualifiedConnectedAccountRef, type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { connectedAccountPurposeServiceTargets } from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storageStore';

const inventoryKeys = { profile: ['id', 'connectedAccountsV4'], profileScope: true } as const;

/**
 * A credential choice the Account cannot make yet: it has no account at all for `service` (unknown until that
 * Account's profile is loaded). `connect` runs the one shared Connect flow and hands the new account to `onConnected`.
 * A form on the shown Account's page with no lifetime of its own passes null: the shown profile decides, and the
 * Connect sheet opens for the active Account (it retires itself if that Account changes).
 */
export function useFirstConnection(
  lifetime: ServerAccountScopeLifetime | null,
  service: PluginContributionIdentityV1 | null,
  onConnected: (account: QualifiedConnectedAccountRef) => void,
) {
  const [acknowledged, setAcknowledged] = React.useState<Readonly<{
    account: QualifiedConnectedAccountRef;
    lifetime: ServerAccountScopeLifetime | null;
  }> | null>(null);
  const awaiting = acknowledged && acknowledged.lifetime === lifetime && service
    && buildQualifiedPluginContributionKey(acknowledged.account.service) === buildQualifiedPluginContributionKey(service)
    ? acknowledged.account : null;
  const inventory = storage((state) => {
    const accountId = lifetime?.scope.accountId ?? state.profileScope?.accountId ?? null;
    if (!service || accountId === null || state.profile.id !== accountId) return awaiting ? 'settling' : 'unknown';
    const { accounts } = connectedAccountPurposeServiceTargets(state.profile.connectedAccountsV4 ?? [], [], service);
    if (awaiting && !accounts.some(candidate => sameQualifiedConnectedAccountRef(candidate.ref, awaiting))) return 'settling';
    return accounts.length > 0 ? 'available' : 'missing';
  }, inventoryKeys);
  // Acknowledgement precedes the inventory push. Once present, the inventory alone decides availability.
  React.useEffect(() => {
    if (acknowledged && (!awaiting || inventory === 'available')) setAcknowledged(null);
  }, [acknowledged, awaiting, inventory]);
  const connect = async () => {
    if (!service) return;
    const result = await presentConnectSheet({
      ...(lifetime ? { scope: lifetime.scope } : {}),
      service,
      intent: 'add',
    });
    if (result.kind === 'dismissed' || lifetime && !lifetime.isCurrent()) return;
    setAcknowledged({ account: result.account, lifetime });
    onConnected(result.account);
  };
  return { missing: inventory === 'missing', pending: inventory === 'settling', connect };
}
