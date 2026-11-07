import * as React from 'react';

import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

// Only the scalar projection survives the page. No inventory, catalog or check loader lives here.
const counts = new WeakMap<ServerAccountScopeLifetime, number | null>();
const listeners = new Set<() => void>();

export function subscribeStoreUpdatesCount(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function publishStoreUpdatesCount(lifetime: ServerAccountScopeLifetime, count: number | null): void {
  if ((counts.get(lifetime) ?? null) === count) return;
  if (!counts.has(lifetime)) {
    lifetime.onRetire(() => {
      const previous = counts.get(lifetime);
      counts.delete(lifetime);
      if (previous != null) for (const listener of [...listeners]) listener();
    });
  }
  counts.set(lifetime, count);
  for (const listener of [...listeners]) listener();
}

/** Passive Store-column/phone badge. It never opens inventory or initiates a check. */
export function useStoreUpdatesCount(scope: ServerAccountScope | null): number | null {
  const read = React.useCallback(() => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    return lifetime ? counts.get(lifetime) ?? null : null;
  }, [scope]);
  return React.useSyncExternalStore(subscribeStoreUpdatesCount, read, read);
}
