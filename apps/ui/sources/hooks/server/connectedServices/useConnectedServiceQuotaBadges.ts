import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { computeConnectedServiceQuotaSummaryBadges } from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';
import type {
  ConnectedServiceQuotaProfileRefInput,
} from '@/sync/domains/connectedServices/connectedServiceQuotaProfileRefs';
import { useSettings } from '@/sync/store/hooks';

import {
  useConnectedServiceQuotaSnapshots,
  type ConnectedServiceQuotaSnapshotsFetchPolicy,
} from './useConnectedServiceQuotaSnapshots';

type UseConnectedServiceQuotaBadgesOptions = Readonly<{
  fetchPolicy?: ConnectedServiceQuotaSnapshotsFetchPolicy;
}>;

const DEFAULT_QUOTA_BADGE_LIMIT = 3;

export function useConnectedServiceQuotaBadges(
  profiles: ReadonlyArray<ConnectedServiceQuotaProfileRefInput>,
  options: UseConnectedServiceQuotaBadgesOptions = {},
): Record<string, Array<{ meterId: string; text: string }>> {
  const settings = useSettings();
  const quotasEnabled = useFeatureEnabled('connectedServices.quotas');

  const pinnedByKey = settings.connectedServicesQuotaPinnedMeterIdsByKey;
  const strategyByKey = settings.connectedServicesQuotaSummaryStrategyByKey;

  const fetchPolicy = options.fetchPolicy ?? 'poll';
  // The snapshots hook is the single normalizer for these refs: badges read the
  // keys it already resolved rather than normalizing the same input again.
  const { profiles: normalizedProfiles, snapshotsByKey } =
    useConnectedServiceQuotaSnapshots(profiles, { fetchPolicy });

  return React.useMemo(() => {
    const badgesByKey: Record<string, Array<{ meterId: string; text: string }>> = {};
    if (!quotasEnabled) return badgesByKey;

    for (const profile of normalizedProfiles) {
      const key = profile.key;
      const pinnedMeterIds = pinnedByKey[key] ?? [];
      const snapshot = snapshotsByKey[key] ?? null;
      if (fetchPolicy === 'cache_only' && !snapshot) {
        badgesByKey[key] = [];
        continue;
      }

      const effectiveMeterIds = pinnedMeterIds.length > 0
        ? pinnedMeterIds
        : (snapshot?.meters ?? []).map((meter) => meter.meterId);
      if (effectiveMeterIds.length === 0) {
        badgesByKey[key] = [];
        continue;
      }

      const rawStrategy = strategyByKey[key];
      const strategy = rawStrategy === 'min_remaining' ? 'min_remaining' : 'primary';
      const badges = computeConnectedServiceQuotaSummaryBadges({
        snapshot,
        pinnedMeterIds: effectiveMeterIds,
        strategy,
      });
      badgesByKey[key] = pinnedMeterIds.length > 0
        ? badges
        : badges.slice(0, DEFAULT_QUOTA_BADGE_LIMIT);
    }

    return badgesByKey;
  }, [
    fetchPolicy,
    normalizedProfiles,
    pinnedByKey,
    quotasEnabled,
    snapshotsByKey,
    strategyByKey,
  ]);
}
