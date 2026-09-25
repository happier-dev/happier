import type { FeaturesResponse } from '@happier-dev/protocol';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { observeServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

/**
 * Reads the transfer policy from the same server endpoint the daemon uses for its session API calls
 * (the effective API URL, which may be a local URL alongside the public one).
 */
export async function readSessionHandoffServerFeatures(params: Readonly<{
  token: string;
  signal?: AbortSignal;
}>): Promise<FeaturesResponse | null> {
  const snapshot = await observeServerFeaturesSnapshot({
    serverUrl: resolveServerHttpBaseUrl(),
    token: params.token,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  return snapshot.status === 'ready' ? snapshot.features : null;
}
