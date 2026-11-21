import * as React from 'react';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { sameQualifiedConnectedAccountRef, type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { connectedAccountPurposeServiceTargets } from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
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
    scope: ServerAccountScopeLifetime | null;
    status: 'checking' | 'unavailable';
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
  // The Account profile decides readiness. One foreground read settles a missed or delayed publication.
  React.useEffect(() => {
    if (!acknowledged) return;
    if (!awaiting || inventory === 'available') {
      setAcknowledged(null);
      return;
    }
    if (acknowledged.status !== 'checking') return;
    const scope = acknowledged.scope;
    const controller = new AbortController();
    const settleUnavailable = () => setAcknowledged(current =>
      current === acknowledged ? { ...current, status: 'unavailable' } : current);
    const retirement = scope?.onRetire(() => {
      controller.abort();
      settleUnavailable();
    });
    void (async () => {
      try {
        if (scope?.isCurrent()) {
          const { refreshAccountProfileOnce } = await import('@/sync/engine/account/syncAccount');
          await refreshAccountProfileOnce(scope, controller.signal, profile => {
            if (!profile.connectedAccountsV4.some(account => sameQualifiedConnectedAccountRef(account.ref, awaiting))) return;
            const state = storage.getState();
            // A push that already settled this connection is newer than the pending read.
            if (areServerAccountScopesEqual(state.profileScope, scope.scope)
              && state.profile.connectedAccountsV4.some(account => sameQualifiedConnectedAccountRef(account.ref, awaiting))) return;
            state.applyProfileForScope(scope.scope, profile);
          });
        }
      } catch {
        // The connection stays saved. The person can retry the profile read.
      } finally {
        if (!controller.signal.aborted) settleUnavailable();
      }
    })();
    return () => {
      retirement?.dispose();
      controller.abort();
    };
  }, [acknowledged, awaiting, inventory]);
  const retry = () => setAcknowledged(current => current ? { ...current, status: 'checking' } : current);
  const connect = async () => {
    if (!service) return;
    const scope = lifetime ?? captureActiveServerAccountScopeLifetime();
    const result = await presentConnectSheet({
      ...(lifetime ? { scope: lifetime.scope } : {}),
      service,
      intent: 'add',
    });
    if (result.kind === 'dismissed' || scope && !scope.isCurrent()) return;
    setAcknowledged({ account: result.account, lifetime, scope, status: 'checking' });
    onConnected(result.account);
  };
  return {
    missing: inventory === 'missing',
    pending: inventory === 'settling' && acknowledged?.status === 'checking',
    unavailable: inventory === 'settling' && acknowledged?.status === 'unavailable',
    connect,
    retry,
  };
}
