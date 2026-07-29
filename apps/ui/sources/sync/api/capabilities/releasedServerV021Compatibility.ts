import type { ServerFeaturesSnapshot } from './serverFeaturesClient';

/**
 * Positive feature evidence for the immutable server-v0.2.1 HTTP contract at
 * 4913c1e533c872a0712ba1c25b3104fd470aacc2.
 *
 * Keep this as the single transport-classification owner for exact 0.2.1 request
 * adapters. Remove it when server-v0.2.1 leaves the supported predecessor window.
 */
export function isReleasedServerV021CompatibilitySnapshot(
  snapshot: ServerFeaturesSnapshot,
): boolean {
  if (snapshot.status !== 'ready') return false;
  return snapshot.features.capabilities.compatibility === undefined
    && snapshot.features.features.sharing.pendingQueueV2.enabled === true
    && snapshot.features.features.sharing.pendingDeliveryState.enabled !== true;
}
