import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import { getConnectedServiceQuotaSnapshotPlain } from '@/sync/api/account/apiConnectedServicesQuotasV3';
import { computeConnectedServiceQuotaSummaryBadges } from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';
import { openConnectedServiceQuotaSnapshot } from '@/sync/domains/connectedServices/openConnectedServiceQuotaSnapshot';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { useSettings } from '@/sync/store/hooks';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol';

type ProfileRef = Readonly<{ serviceId: string; profileId: string }>;

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

const QUOTA_BADGES_POLL_MS = 30_000;
const QUOTA_BADGES_MISS_RETRY_MS = 30_000;
const QUOTA_BADGES_ERROR_BACKOFF_MIN_MS = 30_000;
const QUOTA_BADGES_ERROR_BACKOFF_MAX_MS = 5 * 60_000;

type SnapshotCacheEntry = Readonly<{
  snapshot: ConnectedServiceQuotaSnapshotV1 | null;
  nextFetchAtMs: number;
  consecutiveErrors: number;
}>;

function computeErrorBackoffMs(consecutiveErrors: number): number {
  const exp = QUOTA_BADGES_ERROR_BACKOFF_MIN_MS * Math.pow(2, Math.max(0, consecutiveErrors - 1));
  return Math.max(QUOTA_BADGES_ERROR_BACKOFF_MIN_MS, Math.min(QUOTA_BADGES_ERROR_BACKOFF_MAX_MS, Math.trunc(exp)));
}

export function useConnectedServiceQuotaBadges(
  profiles: ReadonlyArray<ProfileRef>,
): Record<string, Array<{ meterId: string; text: string }>> {
  const auth = useAuth();
  const credentials = auth.credentials;
  const settings = useSettings();
  const quotasEnabled = useFeatureEnabled('connectedServices.quotas');

  const [wakeSeq, setWakeSeq] = React.useState(0);

  const [cacheByKey, setCacheByKey] = React.useState<Record<string, SnapshotCacheEntry>>({});
  const cacheByKeyRef = React.useRef(cacheByKey);
  React.useEffect(() => {
    cacheByKeyRef.current = cacheByKey;
  }, [cacheByKey]);

  type AccountMode = 'plain' | 'e2ee';
  const accountModeRef = React.useRef<AccountMode | null>(null);
  const accountModePromiseRef = React.useRef<Promise<AccountMode> | null>(null);
  React.useEffect(() => {
    accountModeRef.current = null;
    accountModePromiseRef.current = null;
  }, [credentials?.token]);

  const pinnedByKey = settings.connectedServicesQuotaPinnedMeterIdsByKey;
  const strategyByKey = settings.connectedServicesQuotaSummaryStrategyByKey;

  const resolveAccountMode = React.useCallback(async (): Promise<AccountMode> => {
    const cached = accountModeRef.current;
    if (cached) return cached;
    if (!credentials) return 'e2ee';

    const promise =
      accountModePromiseRef.current ??
      (accountModePromiseRef.current = fetchAccountEncryptionMode(credentials)
        .then((res): AccountMode => (res.mode === 'plain' ? 'plain' : 'e2ee'))
        .catch((): AccountMode => 'e2ee')
        .then((mode): AccountMode => {
          accountModeRef.current = mode;
          return mode;
        }));

    return await promise;
  }, [credentials]);

  React.useEffect(() => {
    if (!quotasEnabled) return;
    if (!credentials) return;

    const now = Date.now();
    let nextWakeAtMs = Number.POSITIVE_INFINITY;
    let hasMissingCache = false;

    for (const profile of profiles) {
      const serviceIdRaw = String(profile.serviceId ?? '').trim();
      const serviceIdParsed = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
      const profileId = String(profile.profileId ?? '').trim();
      if (!serviceIdParsed.success || !profileId) continue;
      const serviceId = serviceIdParsed.data;
      const key = connectedServiceProfileKey({ serviceId, profileId });
      const pinned = pinnedByKey[key] ?? [];
      if (pinned.length === 0) continue;

      const cached = cacheByKey[key];
      if (!cached) {
        hasMissingCache = true;
        continue;
      }
      const dueAtMs = cached.nextFetchAtMs;
      nextWakeAtMs = Math.min(nextWakeAtMs, dueAtMs);
    }

    // If we don't have cached scheduling info yet (first load), let the fetch effect run and populate
    // `nextFetchAtMs` before arming timers. This avoids immediate 0ms wake loops/double fetches.
    if (hasMissingCache) return;
    if (!Number.isFinite(nextWakeAtMs)) return;

    const delayMs = Math.max(0, nextWakeAtMs - now);
    const handle = setTimeout(() => setWakeSeq((value) => value + 1), delayMs);
    return () => clearTimeout(handle);
  }, [cacheByKey, credentials, pinnedByKey, profiles, quotasEnabled, wakeSeq]);

  React.useEffect(() => {
    if (!quotasEnabled) return;
    if (!credentials) return;

    const now = Date.now();
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
      const cached = cacheByKeyRef.current[key];
      if (cached && now < cached.nextFetchAtMs) continue;
      toFetch.push({ key, serviceId, profileId });
    }
    if (toFetch.length === 0) return;

    const controller = new AbortController();
    fireAndForget((async () => {
      const mode = await resolveAccountMode();
      await Promise.all(toFetch.map(async (entry) => {
        try {
          let opened: ConnectedServiceQuotaSnapshotV1 | null = null;
          if (mode === 'plain') {
            opened = await getConnectedServiceQuotaSnapshotPlain(credentials, {
              serviceId: entry.serviceId,
              profileId: entry.profileId,
            });
          }
          if (!opened) {
            const sealed = await getConnectedServiceQuotaSnapshotSealed(credentials, {
              serviceId: entry.serviceId,
              profileId: entry.profileId,
            });
            opened = sealed ? openConnectedServiceQuotaSnapshot(credentials, sealed.sealed) : null;
          }
          if (controller.signal.aborted) return;
          setCacheByKey((prev) => {
            const existing = prev[entry.key];
            const nextFetchAtMs = opened
              ? now + Math.max(QUOTA_BADGES_POLL_MS, Math.trunc(opened.staleAfterMs ?? QUOTA_BADGES_POLL_MS))
              : now + QUOTA_BADGES_MISS_RETRY_MS;
            return {
              ...prev,
              [entry.key]: {
                snapshot: opened,
                nextFetchAtMs,
                consecutiveErrors: 0,
              },
            };
          });
        } catch {
          if (controller.signal.aborted) return;
          setCacheByKey((prev) => {
            const existing = prev[entry.key];
            const consecutiveErrors = (existing?.consecutiveErrors ?? 0) + 1;
            return {
              ...prev,
              [entry.key]: {
                snapshot: existing?.snapshot ?? null,
                nextFetchAtMs: now + computeErrorBackoffMs(consecutiveErrors),
                consecutiveErrors,
              },
            };
          });
        }
      }));
    })(), { tag: 'useConnectedServiceQuotaBadges.refresh' });

    return () => controller.abort();
  }, [quotasEnabled, credentials, profiles, pinnedByKey, wakeSeq, resolveAccountMode]);

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
      snapshot: cacheByKey[key]?.snapshot ?? null,
      pinnedMeterIds,
      strategy,
    });
  }

  return badgesByKey;
}
