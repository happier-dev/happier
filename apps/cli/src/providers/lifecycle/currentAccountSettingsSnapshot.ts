import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

/**
 * Keeps a Provider operation tied to one account while re-reading the current
 * version for authorization and commit revalidation. Live mode fails closed
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
    return current.settingsVersion >= input.initial.settingsVersion ? current : null;
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
      if (current.scopeKey !== initial.scopeKey || current.settingsVersion < initial.settingsVersion) {
        return null;
      }
      initial = current;
      return current;
    }
    return current === initial ? current : null;
  };
}
