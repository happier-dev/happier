import * as React from 'react';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';
import { useFeatureLocalPolicySettings } from '@/hooks/server/useFeatureLocalPolicySettings';
import { resolveRuntimeFeatureDecisionFromSnapshot, useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';

/** The library and reach views consume the same scoped feature-decision owner. */
export function useSkillFeatureEnabled(serverId: string | null | undefined) {
  const settings = useFeatureLocalPolicySettings();
  const snapshot = useServerFeaturesSnapshotForServerId(serverId ?? '', { enabled: Boolean(serverId) });
  return React.useCallback((featureId: FeatureId) => resolveRuntimeFeatureDecisionFromSnapshot({ featureId, settings, snapshot,
    scope: { scopeKind: 'spawn', ...(serverId ? { serverId } : {}) } })?.state === 'enabled', [serverId, settings, snapshot]);
}
