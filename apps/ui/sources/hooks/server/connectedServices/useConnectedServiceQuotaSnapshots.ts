import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import { getConnectedServiceQuotaSnapshotPlain } from '@/sync/api/account/apiConnectedServicesQuotasV3';
import { openConnectedServiceQuotaSnapshot } from '@/sync/domains/connectedServices/openConnectedServiceQuotaSnapshot';
import {
    getProviderAccountUsageCacheState,
    subscribeProviderAccountUsageCache,
} from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageCache';
import { projectProviderAccountUsageSnapshotForConnectedServiceAlias } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageSelectors';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { ConnectedServiceIdSchema, type ConnectedServiceId, type ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { useCredentialScopedAccountModeResolver } from './useCredentialScopedAccountModeResolver';

export type ConnectedServiceQuotaProfileRef = Readonly<{
    serviceId: string;
    profileId: string;
}>;

type SnapshotCacheEntry = Readonly<{
    snapshot: ConnectedServiceQuotaSnapshotV1 | null;
    nextFetchAtMs: number;
    consecutiveErrors: number;
    loading: boolean;
}>;
type SnapshotCacheState = Readonly<{
    entriesByCredentialScope: Record<string, Record<string, SnapshotCacheEntry>>;
}>;

type NormalizedProfileRef = Readonly<{
    key: string;
    serviceId: ConnectedServiceId;
    profileId: string;
}>;

export type ConnectedServiceQuotaSnapshotsResult = Readonly<{
    snapshotsByKey: Readonly<Record<string, ConnectedServiceQuotaSnapshotV1 | null>>;
    loadingByKey: Readonly<Record<string, boolean>>;
}>;

export type ConnectedServiceQuotaSnapshotsFetchPolicy = 'poll' | 'cache_only';

const QUOTA_BADGES_POLL_MS = 30_000;
const QUOTA_BADGES_MISS_RETRY_MS = 30_000;
const QUOTA_BADGES_ERROR_BACKOFF_MIN_MS = 30_000;
const QUOTA_BADGES_ERROR_BACKOFF_MAX_MS = 5 * 60_000;

let sharedSnapshotCacheState: SnapshotCacheState = {
    entriesByCredentialScope: {},
};
const sharedSnapshotCacheListeners = new Set<() => void>();

function getSharedSnapshotCacheState(): SnapshotCacheState {
    return sharedSnapshotCacheState;
}

function subscribeSharedSnapshotCache(listener: () => void): () => void {
    sharedSnapshotCacheListeners.add(listener);
    return () => {
        sharedSnapshotCacheListeners.delete(listener);
    };
}

function updateSharedSnapshotCacheEntries(
    credentialScope: string,
    updater: (entries: Record<string, SnapshotCacheEntry>) => Record<string, SnapshotCacheEntry>,
): void {
    if (!credentialScope) return;
    const currentEntries = sharedSnapshotCacheState.entriesByCredentialScope[credentialScope] ?? {};
    const nextEntries = updater(currentEntries);
    sharedSnapshotCacheState = {
        entriesByCredentialScope: {
            ...sharedSnapshotCacheState.entriesByCredentialScope,
            [credentialScope]: nextEntries,
        },
    };
    for (const listener of sharedSnapshotCacheListeners) listener();
}

function computeErrorBackoffMs(consecutiveErrors: number): number {
    const exp = QUOTA_BADGES_ERROR_BACKOFF_MIN_MS * Math.pow(2, Math.max(0, consecutiveErrors - 1));
    return Math.max(QUOTA_BADGES_ERROR_BACKOFF_MIN_MS, Math.min(QUOTA_BADGES_ERROR_BACKOFF_MAX_MS, Math.trunc(exp)));
}

function normalizeProfileRef(profile: ConnectedServiceQuotaProfileRef): NormalizedProfileRef | null {
    const serviceIdRaw = String(profile.serviceId ?? '').trim();
    const parsedServiceId = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
    const profileId = String(profile.profileId ?? '').trim();
    if (!parsedServiceId.success || !profileId) {
        return null;
    }

    return {
        key: connectedServiceProfileKey({ serviceId: parsedServiceId.data, profileId }),
        serviceId: parsedServiceId.data,
        profileId,
    };
}

function normalizeProfileRefs(profiles: ReadonlyArray<ConnectedServiceQuotaProfileRef>): NormalizedProfileRef[] {
    const entries: NormalizedProfileRef[] = [];
    const seenKeys = new Set<string>();
    for (const profile of profiles) {
        const normalized = normalizeProfileRef(profile);
        if (!normalized || seenKeys.has(normalized.key)) {
            continue;
        }
        seenKeys.add(normalized.key);
        entries.push(normalized);
    }
    return entries.sort((a, b) => a.key.localeCompare(b.key));
}

function buildProfilesSignature(profiles: ReadonlyArray<ConnectedServiceQuotaProfileRef>): string {
    return normalizeProfileRefs(profiles)
        .map((profile) => `${profile.key}\u0000${profile.serviceId}\u0000${profile.profileId}`)
        .join('\u0001');
}

export function useConnectedServiceQuotaSnapshots(
    profiles: ReadonlyArray<ConnectedServiceQuotaProfileRef>,
    options: Readonly<{ fetchPolicy?: ConnectedServiceQuotaSnapshotsFetchPolicy }> = {},
): ConnectedServiceQuotaSnapshotsResult {
    const auth = useAuth();
    const credentials = auth.credentials;
    const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
    const credentialScope = quotasEnabled && credentials ? resolveAuthCredentialsScopeKey(credentials) : '';
    const fetchPolicy = options.fetchPolicy ?? 'poll';

    const [wakeSeq, setWakeSeq] = React.useState(0);
    const cacheState = React.useSyncExternalStore(
        subscribeSharedSnapshotCache,
        getSharedSnapshotCacheState,
        getSharedSnapshotCacheState,
    );
    const providerAccountUsageCacheState = React.useSyncExternalStore(
        subscribeProviderAccountUsageCache,
        getProviderAccountUsageCacheState,
        getProviderAccountUsageCacheState,
    );
    const cacheByKey = credentialScope ? cacheState.entriesByCredentialScope[credentialScope] ?? {} : {};
    const providerAccountUsageCacheByRecordId = credentialScope
        ? providerAccountUsageCacheState.entriesByCredentialScope[credentialScope] ?? {}
        : {};
    const cacheStateRef = React.useRef({ credentialScope, entries: cacheByKey });

    React.useEffect(() => {
        cacheStateRef.current = { credentialScope, entries: cacheByKey };
    }, [cacheByKey, credentialScope]);

    const profilesSignature = React.useMemo(() => buildProfilesSignature(profiles), [profiles]);

    const normalizedProfiles = React.useMemo(() => normalizeProfileRefs(profiles), [profilesSignature]);
    const canonicalSnapshotsByKey = React.useMemo(() => {
        const snapshotsByRecordId = Object.fromEntries(
            Object.entries(providerAccountUsageCacheByRecordId).map(([recordId, entry]) => [recordId, entry.snapshot]),
        );
        const next: Record<string, ConnectedServiceQuotaSnapshotV1 | null> = {};
        for (const profile of normalizedProfiles) {
            next[profile.key] = projectProviderAccountUsageSnapshotForConnectedServiceAlias({
                snapshotsByRecordId,
                serviceId: profile.serviceId,
                profileId: profile.profileId,
            });
        }
        return next;
    }, [normalizedProfiles, providerAccountUsageCacheByRecordId]);
    const activeCredentialScopeRef = React.useRef(credentialScope);
    activeCredentialScopeRef.current = credentialScope;
    const activeControllersRef = React.useRef(new Set<AbortController>());

    React.useEffect(() => () => {
        activeCredentialScopeRef.current = '';
        for (const controller of activeControllersRef.current) {
            controller.abort();
        }
        activeControllersRef.current.clear();
    }, []);

    const resolveAccountMode = useCredentialScopedAccountModeResolver({ credentials, credentialScope });

    React.useEffect(() => {
        if (fetchPolicy === 'cache_only' || !quotasEnabled || !credentials || normalizedProfiles.length === 0) return;

        const now = Date.now();
        let nextWakeAtMs = Number.POSITIVE_INFINITY;
        let hasMissingCache = false;

        for (const profile of normalizedProfiles) {
            if (canonicalSnapshotsByKey[profile.key]) {
                continue;
            }
            const cached = cacheByKey[profile.key];
            if (!cached) {
                hasMissingCache = true;
                continue;
            }
            nextWakeAtMs = Math.min(nextWakeAtMs, cached.nextFetchAtMs);
        }

        if (hasMissingCache || !Number.isFinite(nextWakeAtMs)) {
            return;
        }

        const delayMs = Math.max(0, nextWakeAtMs - now);
        const handle = setTimeout(() => setWakeSeq((value) => value + 1), delayMs);
        return () => clearTimeout(handle);
    }, [cacheByKey, canonicalSnapshotsByKey, credentials, fetchPolicy, normalizedProfiles, quotasEnabled, wakeSeq]);

    React.useEffect(() => {
        if (fetchPolicy === 'cache_only' || !quotasEnabled || !credentials || normalizedProfiles.length === 0) {
            return;
        }

        const now = Date.now();
        const toFetch = normalizedProfiles.filter((profile) => {
            if (canonicalSnapshotsByKey[profile.key]) {
                return false;
            }
            const cacheSnapshot = cacheStateRef.current;
            const cached = cacheSnapshot.credentialScope === credentialScope
                ? cacheSnapshot.entries[profile.key]
                : undefined;
            if (!cached) {
                return true;
            }
            if (cached.loading) {
                return false;
            }
            return now >= cached.nextFetchAtMs;
        });

        if (toFetch.length === 0) {
            return;
        }

        updateSharedSnapshotCacheEntries(credentialScope, (entries) => {
            const next = { ...entries };
            for (const profile of toFetch) {
                const existing = entries[profile.key];
                next[profile.key] = {
                    snapshot: existing?.snapshot ?? null,
                    nextFetchAtMs: existing?.nextFetchAtMs ?? now,
                    consecutiveErrors: existing?.consecutiveErrors ?? 0,
                    loading: true,
                };
            }
            return next;
        });

        const controller = new AbortController();
        const requestCredentialScope = credentialScope;
        activeControllersRef.current.add(controller);
        fireAndForget((async () => {
            try {
                const mode = await resolveAccountMode();
                if (controller.signal.aborted || activeCredentialScopeRef.current !== requestCredentialScope) return;
                await Promise.all(toFetch.map(async (entry) => {
                    try {
                        let opened: ConnectedServiceQuotaSnapshotV1 | null = null;
                        if (mode === 'plain') {
                            opened = await getConnectedServiceQuotaSnapshotPlain(credentials, {
                                serviceId: entry.serviceId,
                                profileId: entry.profileId,
                            }, { signal: controller.signal });
                        }
                        if (controller.signal.aborted || activeCredentialScopeRef.current !== requestCredentialScope) return;
                        if (!opened) {
                            const sealed = await getConnectedServiceQuotaSnapshotSealed(credentials, {
                                serviceId: entry.serviceId,
                                profileId: entry.profileId,
                            }, { signal: controller.signal });
                            opened = sealed ? openConnectedServiceQuotaSnapshot(credentials, sealed.sealed) : null;
                        }
                        if (controller.signal.aborted || activeCredentialScopeRef.current !== requestCredentialScope) return;

                        updateSharedSnapshotCacheEntries(requestCredentialScope, (entries) => ({
                            ...entries,
                            [entry.key]: {
                                snapshot: opened,
                                nextFetchAtMs: opened
                                    ? now + Math.max(QUOTA_BADGES_POLL_MS, Math.trunc(opened.staleAfterMs ?? QUOTA_BADGES_POLL_MS))
                                    : now + QUOTA_BADGES_MISS_RETRY_MS,
                                consecutiveErrors: 0,
                                loading: false,
                            },
                        }));
                    } catch {
                        if (controller.signal.aborted || activeCredentialScopeRef.current !== requestCredentialScope) return;
                        updateSharedSnapshotCacheEntries(requestCredentialScope, (entries) => {
                            const existing = entries[entry.key];
                            const consecutiveErrors = (existing?.consecutiveErrors ?? 0) + 1;
                            return {
                                ...entries,
                                [entry.key]: {
                                    snapshot: existing?.snapshot ?? null,
                                    nextFetchAtMs: now + computeErrorBackoffMs(consecutiveErrors),
                                    consecutiveErrors,
                                    loading: false,
                                },
                            };
                        });
                    }
                }));
            } finally {
                activeControllersRef.current.delete(controller);
            }
        })(), { tag: 'useConnectedServiceQuotaSnapshots.refresh' });

        return () => {
            if (activeCredentialScopeRef.current !== requestCredentialScope) {
                controller.abort();
            }
        };
    }, [canonicalSnapshotsByKey, credentialScope, credentials, fetchPolicy, normalizedProfiles, quotasEnabled, resolveAccountMode, wakeSeq]);

    return React.useMemo(() => {
        if (!quotasEnabled) {
            return {
                snapshotsByKey: {},
                loadingByKey: {},
            } satisfies ConnectedServiceQuotaSnapshotsResult;
        }

        const snapshotsByKey: Record<string, ConnectedServiceQuotaSnapshotV1 | null> = {};
        const loadingByKey: Record<string, boolean> = {};
        for (const profile of normalizedProfiles) {
            const cached = cacheByKey[profile.key];
            snapshotsByKey[profile.key] = canonicalSnapshotsByKey[profile.key] ?? cached?.snapshot ?? null;
            loadingByKey[profile.key] = cached?.loading ?? false;
        }
        return {
            snapshotsByKey,
            loadingByKey,
        } satisfies ConnectedServiceQuotaSnapshotsResult;
    }, [cacheByKey, canonicalSnapshotsByKey, normalizedProfiles, quotasEnabled]);
}
