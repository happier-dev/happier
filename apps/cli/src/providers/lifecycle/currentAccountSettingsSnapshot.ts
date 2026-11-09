import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { isDeepStrictEqual } from 'node:util';

/** Material delivery consumes these facts; picker/model preferences and row revisions are independent. */
export function sameProviderConnectionsDirectMaterial(
  admitted: ActiveAccountSettingsSnapshot['providerConnectionsCatalog'],
  current: ActiveAccountSettingsSnapshot['providerConnectionsCatalog'],
): boolean {
  if (admitted === current) return true;
  if (admitted?.status !== 'ready' || current?.status !== 'ready') return false;
  return (['connections', 'accountGrants', 'machineGrants', 'secretBindingsByConnectionId'] as const)
    .every(field => isDeepStrictEqual(admitted.catalog[field], current.catalog[field]));
}

/** Cleanup reports wrap an admitted row without changing its revision or catalog. */
export function sameProviderConnectionsCatalogAuthority(
  admitted: ActiveAccountSettingsSnapshot['providerConnectionsCatalog'],
  current: ActiveAccountSettingsSnapshot['providerConnectionsCatalog'],
): boolean {
  return admitted === current || admitted?.status === 'ready' && current?.status === 'ready'
    && admitted.revision === current.revision && admitted.catalog === current.catalog;
}

/**
 * Keeps Provider reads tied to one Account. Each new admission consumes the
 * current owner result, not a settings revision fence. Live mode fails closed
 * when that owner disappears or changes scope; static mode is only for an
 * operation that had no live settings owner and intentionally retains its
 * bootstrap snapshot.
 */
export function createAuthoritativeProviderSnapshotReader(input: Readonly<{
  initial: ActiveAccountSettingsSnapshot;
  readCurrent: () => ActiveAccountSettingsSnapshot | null;
  mode: 'live' | 'static';
}>): () => ActiveAccountSettingsSnapshot | null {
  return () => {
    if (input.mode === 'static') return input.initial;
    const current = input.readCurrent();
    if (!current) return null;
    if (!input.initial.scopeKey || current.scopeKey !== input.initial.scopeKey) return null;
    return current;
  };
}

/**
 * Pins a long-lived authorization attempt to the account snapshot observed on
 * its first read. Scoped snapshots are compared by account scope; legacy
 * unscoped readers are accepted only while they return the exact same object.
 */
export function createAccountBoundProviderSnapshotReader(
  readCurrent: () => ActiveAccountSettingsSnapshot | null,
): () => ActiveAccountSettingsSnapshot | null {
  let initial: ActiveAccountSettingsSnapshot | null = null;
  return () => {
    const current = readCurrent();
    if (!current) return null;
    if (!initial) {
      initial = current;
      return current;
    }
    if (initial.scopeKey) {
      if (current.scopeKey !== initial.scopeKey) {
        return null;
      }
      initial = current;
      return current;
    }
    return current === initial ? current : null;
  };
}
