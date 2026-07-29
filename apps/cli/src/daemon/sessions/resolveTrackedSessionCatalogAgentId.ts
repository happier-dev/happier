import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

import {
  normalizeDaemonBackendTargetV2Input,
  resolveDaemonCatalogAgentIdFromBackendTarget,
} from '@/daemon/backendTargetRouting';
import type { TrackedSession } from '@/daemon/types';
import type { CatalogAgentId } from '@/agent/catalog/ids';

type TrackedSessionCatalogIdentityInput = Pick<
  TrackedSession,
  'happySessionMetadataFromLocalWebhook' | 'spawnOptions'
>;

export function resolveTrackedSessionCatalogAgentId(
  tracked: TrackedSessionCatalogIdentityInput | null | undefined,
): CatalogAgentId | null {
  if (!tracked) return null;

  const backendTarget = tracked.spawnOptions?.backendTarget;
  const normalizedBackendTarget = normalizeDaemonBackendTargetV2Input(backendTarget);
  if (normalizedBackendTarget) {
    return resolveDaemonCatalogAgentIdFromBackendTarget(normalizedBackendTarget);
  }

  return resolveAgentIdFromSessionMetadata(tracked.happySessionMetadataFromLocalWebhook);
}
