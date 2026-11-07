import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
  readProviderAccountUsageSnapshotCacheVersion,
  readProviderAccountUsageSnapshotFromCache,
  subscribeProviderAccountUsageSnapshotCache,
  writeProviderAccountUsageSnapshotToCache,
} from '@/sync/domains/connectedServices/accountUsage/cache';
import { fetchProviderAccountUsageSnapshot } from '@/sync/domains/connectedServices/accountUsage/refreshProviderAccountUsage';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  ProviderAccountUsageRecordIdSchema,
  type ProviderAccountUsageRecordId,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { useCredentialScopedAccountModeResolver } from './useCredentialScopedAccountModeResolver';

const ACCOUNT_USAGE_SNAPSHOTS_POLL_MS = 30_000;
const ACCOUNT_USAGE_SNAPSHOTS_MISS_RETRY_MS = 30_000;
const ACCOUNT_USAGE_SNAPSHOTS_ERROR_BACKOFF_MIN_MS = 30_000;
const ACCOUNT_USAGE_SNAPSHOTS_ERROR_BACKOFF_MAX_MS = 5 * 60_000;

type SnapshotCacheEntry = Readonly<{
  snapshot: ProviderAccountUsageSnapshotV1 | null;
  nextFetchAtMs: number;
  consecutiveErrors: number;
}>;
type SnapshotCacheState = Readonly<{
  credentialScope: string;
  entries: Record<string, SnapshotCacheEntry>;
}>;

function computeErrorBackoffMs(consecutiveErrors: number): number {
  const exp = ACCOUNT_USAGE_SNAPSHOTS_ERROR_BACKOFF_MIN_MS * Math.pow(2, Math.max(0, consecutiveErrors - 1));
  return Math.max(
    ACCOUNT_USAGE_SNAPSHOTS_ERROR_BACKOFF_MIN_MS,
    Math.min(ACCOUNT_USAGE_SNAPSHOTS_ERROR_BACKOFF_MAX_MS, Math.trunc(exp)),
  );
}

function computeSnapshotFreshUntilMs(snapshot: ProviderAccountUsageSnapshotV1): number {
  return snapshot.fetchedAtMs + Math.max(
    ACCOUNT_USAGE_SNAPSHOTS_POLL_MS,
    Math.trunc(snapshot.staleAfterMs),
  );
}

function computeFetchedSnapshotNextFetchAtMs(nowMs: number, snapshot: ProviderAccountUsageSnapshotV1): number {
  return nowMs + Math.max(
    ACCOUNT_USAGE_SNAPSHOTS_POLL_MS,
    Math.trunc(snapshot.staleAfterMs),
  );
}

function normalizeRecordIds(recordIds: ReadonlyArray<string>): ProviderAccountUsageRecordId[] {
  const seen = new Set<string>();
  const normalized: ProviderAccountUsageRecordId[] = [];
  for (const rawRecordId of recordIds) {
    const parsed = ProviderAccountUsageRecordIdSchema.safeParse(rawRecordId);
    if (!parsed.success || seen.has(parsed.data)) continue;
    seen.add(parsed.data);
    normalized.push(parsed.data);
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

function buildRecordIdsSignature(recordIds: ReadonlyArray<string>): string {
  return normalizeRecordIds(recordIds).join('\u0001');
}

export function useProviderAccountUsageSnapshots(
  recordIds: ReadonlyArray<string>,
): Record<string, ProviderAccountUsageSnapshotV1 | null> {
  const auth = useAuth();
  const credentials = auth.credentials;
  const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
  const [wakeSeq, setWakeSeq] = React.useState(0);
  const credentialScope = quotasEnabled && credentials ? resolveAuthCredentialsScopeKey(credentials) : '';

  const [cacheState, setCacheState] = React.useState<SnapshotCacheState>({
    credentialScope: '',
    entries: {},
  });
  const cacheByRecordId = cacheState.credentialScope === credentialScope ? cacheState.entries : {};
  const cacheStateRef = React.useRef(cacheState);
  React.useEffect(() => {
    cacheStateRef.current = cacheState;
  }, [cacheState]);

  React.useEffect(() => {
    const resetState = { credentialScope, entries: {} };
    cacheStateRef.current = resetState;
    setCacheState(resetState);
  }, [credentialScope]);
  const resolveAccountMode = useCredentialScopedAccountModeResolver({ credentials, credentialScope });

  const recordIdsSignature = React.useMemo(() => buildRecordIdsSignature(recordIds), [recordIds]);
  const normalizedRecordIds = React.useMemo(() => normalizeRecordIds(recordIds), [recordIdsSignature]);
  const activeCredentialScopeRef = React.useRef(credentialScope);
  activeCredentialScopeRef.current = credentialScope;
  const activeControllersRef = React.useRef(new Set<AbortController>());
  const inFlightKeysRef = React.useRef(new Set<string>());
  const subscribeAccountUsageCache = React.useCallback((onChange: () => void) => (
    subscribeProviderAccountUsageSnapshotCache({ credentialScope }, onChange)
  ), [credentialScope]);
  const getAccountUsageCacheVersion = React.useCallback(() => (
    readProviderAccountUsageSnapshotCacheVersion({ credentialScope })
  ), [credentialScope]);
  const accountUsageCacheVersion = React.useSyncExternalStore(
    subscribeAccountUsageCache,
    getAccountUsageCacheVersion,
    getAccountUsageCacheVersion,
  );

  React.useEffect(() => () => {
    activeCredentialScopeRef.current = '';
    for (const controller of activeControllersRef.current) {
      controller.abort();
    }
    activeControllersRef.current.clear();
  }, []);

  React.useEffect(() => {
    if (!quotasEnabled) return;
    if (!credentials) return;

    const now = Date.now();
    let nextWakeAtMs = Number.POSITIVE_INFINITY;
    let hasMissingCache = false;

    for (const recordId of normalizedRecordIds) {
      const sharedSnapshot = readProviderAccountUsageSnapshotFromCache({ credentialScope, recordId });
      if (sharedSnapshot && now < computeSnapshotFreshUntilMs(sharedSnapshot)) {
        nextWakeAtMs = Math.min(nextWakeAtMs, computeSnapshotFreshUntilMs(sharedSnapshot));
        continue;
      }
      const cached = cacheByRecordId[recordId];
      if (!cached) {
        hasMissingCache = true;
        continue;
      }
      nextWakeAtMs = Math.min(nextWakeAtMs, cached.nextFetchAtMs);
    }

    if (hasMissingCache) return;
    if (!Number.isFinite(nextWakeAtMs)) return;

    const delayMs = Math.max(0, nextWakeAtMs - now);
    const handle = setTimeout(() => setWakeSeq((value) => value + 1), delayMs);
    return () => clearTimeout(handle);
  }, [accountUsageCacheVersion, cacheByRecordId, credentialScope, credentials, normalizedRecordIds, quotasEnabled, wakeSeq]);

  React.useEffect(() => {
    if (!quotasEnabled) return;
    if (!credentials) return;

    const now = Date.now();
    const toFetch = normalizedRecordIds.filter((recordId) => {
      const sharedSnapshot = readProviderAccountUsageSnapshotFromCache({ credentialScope, recordId });
      if (sharedSnapshot && now < computeSnapshotFreshUntilMs(sharedSnapshot)) return false;
      const cacheSnapshot = cacheStateRef.current;
      const cached = cacheSnapshot.credentialScope === credentialScope
        ? cacheSnapshot.entries[recordId]
        : undefined;
      const inFlightKey = `${credentialScope}\u0000${recordId}`;
      return !inFlightKeysRef.current.has(inFlightKey) && (!cached || now >= cached.nextFetchAtMs);
    });
    if (toFetch.length === 0) return;

    for (const recordId of toFetch) {
      inFlightKeysRef.current.add(`${credentialScope}\u0000${recordId}`);
    }

    const controller = new AbortController();
    const requestCredentialScope = credentialScope;
    activeControllersRef.current.add(controller);
    fireAndForget((async () => {
      try {
        const mode = await resolveAccountMode();
        if (controller.signal.aborted || activeCredentialScopeRef.current !== requestCredentialScope) return;
        await Promise.all(toFetch.map(async (recordId) => {
          try {
            let opened: ProviderAccountUsageSnapshotV1 | null = await fetchProviderAccountUsageSnapshot({
              credentials,
              recordId,
              mode,
              signal: controller.signal,
            });
            if (controller.signal.aborted || activeCredentialScopeRef.current !== requestCredentialScope) return;
            if (opened && opened.recordId !== recordId) {
              opened = null;
            }
            if (opened) {
              writeProviderAccountUsageSnapshotToCache({ credentialScope: requestCredentialScope, snapshot: opened });
            }
            setCacheState((prev) => {
              const entries = prev.credentialScope === requestCredentialScope ? prev.entries : {};
              return {
                credentialScope: requestCredentialScope,
                entries: {
                  ...entries,
                  [recordId]: {
                    snapshot: opened,
                    nextFetchAtMs: opened
                      ? computeFetchedSnapshotNextFetchAtMs(now, opened)
                      : now + ACCOUNT_USAGE_SNAPSHOTS_MISS_RETRY_MS,
                    consecutiveErrors: 0,
                  },
                },
              };
            });
          } catch {
            if (controller.signal.aborted || activeCredentialScopeRef.current !== requestCredentialScope) return;
            setCacheState((prev) => {
              const entries = prev.credentialScope === requestCredentialScope ? prev.entries : {};
              const existing = entries[recordId];
              const consecutiveErrors = (existing?.consecutiveErrors ?? 0) + 1;
              return {
                credentialScope: requestCredentialScope,
                entries: {
                  ...entries,
                  [recordId]: {
                    snapshot: existing?.snapshot ?? null,
                    nextFetchAtMs: now + computeErrorBackoffMs(consecutiveErrors),
                    consecutiveErrors,
                  },
                },
              };
            });
          } finally {
            inFlightKeysRef.current.delete(`${requestCredentialScope}\u0000${recordId}`);
          }
        }));
      } finally {
        activeControllersRef.current.delete(controller);
      }
    })(), { tag: 'useProviderAccountUsageSnapshots.refresh' });

    return () => {
      if (activeCredentialScopeRef.current !== requestCredentialScope) {
        controller.abort();
      }
    };
  }, [accountUsageCacheVersion, credentialScope, quotasEnabled, credentials, normalizedRecordIds, wakeSeq, resolveAccountMode]);

  const snapshotsByRecordId: Record<string, ProviderAccountUsageSnapshotV1 | null> = {};
  if (!quotasEnabled || !credentialScope) return snapshotsByRecordId;

  for (const recordId of normalizedRecordIds) {
    snapshotsByRecordId[recordId] =
      readProviderAccountUsageSnapshotFromCache({ credentialScope, recordId })
      ?? cacheByRecordId[recordId]?.snapshot
      ?? null;
  }

  return snapshotsByRecordId;
}
