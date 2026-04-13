import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import { getConnectedServiceQuotaSnapshotPlain } from '@/sync/api/account/apiConnectedServicesQuotasV3';
import { openConnectedServiceQuotaSnapshot } from '@/sync/domains/connectedServices/openConnectedServiceQuotaSnapshot';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { ConnectedServiceIdSchema, type ConnectedServiceId, type ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

export type ConnectedServiceQuotaProfileRef = Readonly<{
    serviceId: string;
    profileId: string;
}>;

type AccountMode = 'plain' | 'e2ee';

type SnapshotCacheEntry = Readonly<{
    snapshot: ConnectedServiceQuotaSnapshotV1 | null;
    nextFetchAtMs: number;
    consecutiveErrors: number;
    loading: boolean;
}>;

export type ConnectedServiceQuotaSnapshotsResult = Readonly<{
    snapshotsByKey: Readonly<Record<string, ConnectedServiceQuotaSnapshotV1 | null>>;
    loadingByKey: Readonly<Record<string, boolean>>;
}>;

const QUOTA_BADGES_POLL_MS = 30_000;
const QUOTA_BADGES_MISS_RETRY_MS = 30_000;
const QUOTA_BADGES_ERROR_BACKOFF_MIN_MS = 30_000;
const QUOTA_BADGES_ERROR_BACKOFF_MAX_MS = 5 * 60_000;

function computeErrorBackoffMs(consecutiveErrors: number): number {
    const exp = QUOTA_BADGES_ERROR_BACKOFF_MIN_MS * Math.pow(2, Math.max(0, consecutiveErrors - 1));
    return Math.max(QUOTA_BADGES_ERROR_BACKOFF_MIN_MS, Math.min(QUOTA_BADGES_ERROR_BACKOFF_MAX_MS, Math.trunc(exp)));
}

function normalizeProfileRef(profile: ConnectedServiceQuotaProfileRef): Readonly<{
    key: string;
    serviceId: ConnectedServiceId;
    profileId: string;
}> | null {
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

export function useConnectedServiceQuotaSnapshots(
    profiles: ReadonlyArray<ConnectedServiceQuotaProfileRef>,
): ConnectedServiceQuotaSnapshotsResult {
    const auth = useAuth();
    const credentials = auth.credentials;
    const quotasEnabled = useFeatureEnabled('connectedServices.quotas');

    const [wakeSeq, setWakeSeq] = React.useState(0);
    const [cacheByKey, setCacheByKey] = React.useState<Record<string, SnapshotCacheEntry>>({});
    const cacheByKeyRef = React.useRef(cacheByKey);

    React.useEffect(() => {
        cacheByKeyRef.current = cacheByKey;
    }, [cacheByKey]);

    const accountModeRef = React.useRef<AccountMode | null>(null);
    const accountModePromiseRef = React.useRef<Promise<AccountMode> | null>(null);

    React.useEffect(() => {
        accountModeRef.current = null;
        accountModePromiseRef.current = null;
    }, [credentials?.token]);

    const profilesSignature = React.useMemo(
        () => profiles
            .map((profile) => `${String(profile.serviceId ?? '').trim()}::${String(profile.profileId ?? '').trim()}`)
            .join('||'),
        [profiles],
    );

    const normalizedProfiles = React.useMemo(() => {
        const entries: Array<Readonly<{
            key: string;
            serviceId: ConnectedServiceId;
            profileId: string;
        }>> = [];
        const seenKeys = new Set<string>();
        for (const profile of profiles) {
            const normalized = normalizeProfileRef(profile);
            if (!normalized || seenKeys.has(normalized.key)) {
                continue;
            }
            seenKeys.add(normalized.key);
            entries.push(normalized);
        }
        return entries;
    }, [profilesSignature]);

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
        if (!quotasEnabled || !credentials || normalizedProfiles.length === 0) return;

        const now = Date.now();
        let nextWakeAtMs = Number.POSITIVE_INFINITY;
        let hasMissingCache = false;

        for (const profile of normalizedProfiles) {
            const cached = cacheByKeyRef.current[profile.key];
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
    }, [cacheByKey, credentials, normalizedProfiles, quotasEnabled, wakeSeq]);

    React.useEffect(() => {
        if (!quotasEnabled || !credentials || normalizedProfiles.length === 0) {
            return;
        }

        const now = Date.now();
        const toFetch = normalizedProfiles.filter((profile) => {
            const cached = cacheByKeyRef.current[profile.key];
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

        setCacheByKey((prev) => {
            const next = { ...prev };
            for (const profile of toFetch) {
                const existing = prev[profile.key];
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

                    setCacheByKey((prev) => ({
                        ...prev,
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
                                loading: false,
                            },
                        };
                    });
                }
            }));
        })(), { tag: 'useConnectedServiceQuotaSnapshots.refresh' });

        return () => controller.abort();
    }, [credentials, normalizedProfiles, quotasEnabled, resolveAccountMode, wakeSeq]);

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
            snapshotsByKey[profile.key] = cached?.snapshot ?? null;
            loadingByKey[profile.key] = cached?.loading ?? false;
        }
        return {
            snapshotsByKey,
            loadingByKey,
        } satisfies ConnectedServiceQuotaSnapshotsResult;
    }, [cacheByKey, normalizedProfiles, quotasEnabled]);
}
