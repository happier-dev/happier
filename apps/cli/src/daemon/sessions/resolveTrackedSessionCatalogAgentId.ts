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
  if (backendTarget?.sourceKind === 'built_in') {
    return resolveDaemonCatalogAgentIdFromBackendTarget(backendTarget);
  }
  const normalizedBackendTarget = normalizeDaemonBackendTargetV2Input(backendTarget);
  if (normalizedBackendTarget) {
    return resolveDaemonCatalogAgentIdFromBackendTarget(normalizedBackendTarget);
  }

  return resolveAgentIdFromSessionMetadata(tracked.happySessionMetadataFromLocalWebhook);
}

/** The opened runtime's identity also exists for a configured ACP selection. */
export function resolveTrackedSessionRuntimeAgentId(
  tracked: TrackedSessionCatalogIdentityInput | null | undefined,
): CatalogAgentId | null {
  const backendTarget = tracked?.spawnOptions?.backendTarget;
  // Preserve the admitted contribution id, including its retained definition.
  if (backendTarget?.sourceKind === 'built_in') {
    return resolveTrackedSessionCatalogAgentId(tracked);
  }
  if (normalizeDaemonBackendTargetV2Input(backendTarget)?.sourceKind === 'configured') {
    return resolveAgentIdFromSessionMetadata(tracked?.happySessionMetadataFromLocalWebhook);
  }
  return resolveTrackedSessionCatalogAgentId(tracked);
}
