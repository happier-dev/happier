import * as React from 'react';

import type { RegistryUpdateCheckState } from '@/registries/useRegistryUpdateCheck';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import type { ManagedInventoryRow as InstalledRow } from '../inventory/useManagedInventory';
import { buildStoreUpdates, type StoreUpdatesView } from './storeUpdatesModel';
import { publishStoreUpdatesCount } from './storeUpdatesSummary';

/** The open page and its passive summary consume the very same held owner facts. */
export function useStoreUpdates(rows: readonly InstalledRow[], check: RegistryUpdateCheckState,
  scope: ServerAccountScope | null, presented: boolean, inventoryReady: boolean): StoreUpdatesView {
  const view = React.useMemo(() => buildStoreUpdates(rows, check.results,
    { checkedAt: inventoryReady ? check.checkedAt : null, attemptedAt: check.attemptedAt, failed: check.failed, basis: check.basis }),
    [rows, check.results, check.checkedAt, check.attemptedAt, check.failed, check.basis, inventoryReady]);
  const lifetime = captureActiveServerAccountScopeLifetime();
  React.useLayoutEffect(() => {
    if (!presented) return;
    if (lifetime) publishStoreUpdatesCount(lifetime, view.count);
  }, [scope, lifetime, presented, view.count]);
  return view;
}
