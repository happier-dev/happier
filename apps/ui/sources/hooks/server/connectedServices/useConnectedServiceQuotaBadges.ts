import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { computeConnectedServiceQuotaSummaryBadges } from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { useSettings } from '@/sync/store/hooks';

import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol';
import {
  useConnectedServiceQuotaSnapshots,
  type ConnectedServiceQuotaSnapshotsFetchPolicy,
} from './useConnectedServiceQuotaSnapshots';

type ProfileRef = Readonly<{ serviceId: string; profileId: string }>;
type NormalizedProfileRef = Readonly<{
  key: string;
  serviceId: ConnectedServiceId;
  profileId: string;
}>;

type UseConnectedServiceQuotaBadgesOptions = Readonly<{
  fetchPolicy?: ConnectedServiceQuotaSnapshotsFetchPolicy;
}>;

const DEFAULT_QUOTA_BADGE_LIMIT = 3;

function normalizeProfileRefs(profiles: ReadonlyArray<ProfileRef>): NormalizedProfileRef[] {
  const next: NormalizedProfileRef[] = [];
  const seenKeys = new Set<string>();
  for (const profile of profiles) {
    const serviceIdRaw = String(profile.serviceId ?? '').trim();
    const serviceIdParsed = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
    const profileId = String(profile.profileId ?? '').trim();
    if (!serviceIdParsed.success || !profileId) continue;

    const serviceId = serviceIdParsed.data;
    const key = connectedServiceProfileKey({ serviceId, profileId });
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    next.push({ key, serviceId, profileId });
  }
  return next;
}

export function useConnectedServiceQuotaBadges(
  profiles: ReadonlyArray<ProfileRef>,
  options: UseConnectedServiceQuotaBadgesOptions = {},
): Record<string, Array<{ meterId: string; text: string }>> {
  const settings = useSettings();
  const quotasEnabled = useFeatureEnabled('connectedServices.quotas');

  const pinnedByKey = settings.connectedServicesQuotaPinnedMeterIdsByKey;
  const strategyByKey = settings.connectedServicesQuotaSummaryStrategyByKey;

  const normalizedProfiles = React.useMemo(() => normalizeProfileRefs(profiles), [profiles]);

  const fetchPolicy = options.fetchPolicy ?? 'poll';
  const { snapshotsByKey } = useConnectedServiceQuotaSnapshots(normalizedProfiles, { fetchPolicy });

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
