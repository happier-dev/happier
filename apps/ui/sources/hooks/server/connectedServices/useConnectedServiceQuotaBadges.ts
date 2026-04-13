import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { computeConnectedServiceQuotaSummaryBadges } from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { useSettings } from '@/sync/store/hooks';

import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol';
import { useConnectedServiceQuotaSnapshots } from './useConnectedServiceQuotaSnapshots';

type ProfileRef = Readonly<{ serviceId: string; profileId: string }>;

export function useConnectedServiceQuotaBadges(
  profiles: ReadonlyArray<ProfileRef>,
): Record<string, Array<{ meterId: string; text: string }>> {
  const settings = useSettings();
  const quotasEnabled = useFeatureEnabled('connectedServices.quotas');

  const pinnedByKey = settings.connectedServicesQuotaPinnedMeterIdsByKey;
  const strategyByKey = settings.connectedServicesQuotaSummaryStrategyByKey;

  const fetchableProfiles = React.useMemo(() => (
    profiles.filter((profile) => {
      const serviceIdRaw = String(profile.serviceId ?? '').trim();
      const serviceIdParsed = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
      const profileId = String(profile.profileId ?? '').trim();
      if (!serviceIdParsed.success || !profileId) return false;
      const serviceId = serviceIdParsed.data;
      const key = connectedServiceProfileKey({ serviceId, profileId });
      return (pinnedByKey[key] ?? []).length > 0;
    })
  ), [pinnedByKey, profiles]);

  const { snapshotsByKey } = useConnectedServiceQuotaSnapshots(fetchableProfiles);

  const badgesByKey: Record<string, Array<{ meterId: string; text: string }>> = {};
  if (!quotasEnabled) return badgesByKey;

  for (const profile of profiles) {
    const serviceIdRaw = String(profile.serviceId ?? '').trim();
    const serviceIdParsed = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
    const profileId = String(profile.profileId ?? '').trim();
    if (!serviceIdParsed.success || !profileId) continue;
    const serviceId = serviceIdParsed.data;

    const key = connectedServiceProfileKey({ serviceId, profileId });
    const pinnedMeterIds = pinnedByKey[key] ?? [];
    if (pinnedMeterIds.length === 0) {
      badgesByKey[key] = [];
      continue;
    }
    const rawStrategy = strategyByKey[key];
    const strategy = rawStrategy === 'min_remaining' ? 'min_remaining' : 'primary';
    badgesByKey[key] = computeConnectedServiceQuotaSummaryBadges({
      snapshot: snapshotsByKey[key] ?? null,
      pinnedMeterIds,
      strategy,
    });
  }

  return badgesByKey;
}
