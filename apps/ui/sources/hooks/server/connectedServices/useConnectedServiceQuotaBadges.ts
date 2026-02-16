import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import { computeConnectedServiceQuotaSummaryBadges } from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';
import { openConnectedServiceQuotaSnapshot } from '@/sync/domains/connectedServices/openConnectedServiceQuotaSnapshot';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { useSettings } from '@/sync/store/hooks';

import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol';

type ProfileRef = Readonly<{ serviceId: string; profileId: string }>;

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function useConnectedServiceQuotaBadges(
  profiles: ReadonlyArray<ProfileRef>,
): Record<string, Array<{ meterId: string; text: string }>> {
  const auth = useAuth();
  const credentials = auth.credentials;
  const settings = useSettings();
  const quotasEnabled = useFeatureEnabled('connected.services.quotas');

  const [snapshotsByKey, setSnapshotsByKey] = React.useState<Record<string, ConnectedServiceQuotaSnapshotV1 | null>>({});
  const snapshotsByKeyRef = React.useRef(snapshotsByKey);
  React.useEffect(() => {
    snapshotsByKeyRef.current = snapshotsByKey;
  }, [snapshotsByKey]);

  const pinnedByKey = settings.connectedServicesQuotaPinnedMeterIdsByKey;

  React.useEffect(() => {
    if (!quotasEnabled) return;
    if (!credentials) return;

    const toFetch: Array<{ key: string; serviceId: ConnectedServiceId; profileId: string }> = [];
    for (const profile of profiles) {
      const serviceIdRaw = String(profile.serviceId ?? '').trim();
      const serviceIdParsed = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
      const profileId = String(profile.profileId ?? '').trim();
      if (!serviceIdParsed.success || !profileId) continue;
      const serviceId = serviceIdParsed.data;
      const key = connectedServiceProfileKey({ serviceId, profileId });
      const pinned = pinnedByKey[key] ?? [];
      if (pinned.length === 0) continue;
      if (hasOwn(snapshotsByKeyRef.current, key)) continue;
      toFetch.push({ key, serviceId, profileId });
    }
    if (toFetch.length === 0) return;

    const controller = new AbortController();
    void (async () => {
      await Promise.all(toFetch.map(async (entry) => {
        try {
          const sealed = await getConnectedServiceQuotaSnapshotSealed(credentials, {
            serviceId: entry.serviceId,
            profileId: entry.profileId,
          });
          const opened = sealed ? openConnectedServiceQuotaSnapshot(credentials, sealed.sealed) : null;
          if (controller.signal.aborted) return;
          setSnapshotsByKey((prev) => (hasOwn(prev, entry.key) ? prev : { ...prev, [entry.key]: opened }));
        } catch {
          if (controller.signal.aborted) return;
          setSnapshotsByKey((prev) => (hasOwn(prev, entry.key) ? prev : { ...prev, [entry.key]: null }));
        }
      }));
    })();

    return () => controller.abort();
  }, [quotasEnabled, credentials, profiles, pinnedByKey]);

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
    badgesByKey[key] = computeConnectedServiceQuotaSummaryBadges({
      snapshot: snapshotsByKey[key] ?? null,
      pinnedMeterIds,
    });
  }

  return badgesByKey;
}
