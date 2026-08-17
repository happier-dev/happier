import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    getProviderAccountUsageSnapshotPlain,
    getProviderAccountUsageSnapshotSealed,
} from '@/sync/api/account/apiProviderAccountUsage';
import {
    getProviderAccountUsageCacheState,
    subscribeProviderAccountUsageCache,
    updateProviderAccountUsageCacheEntries,
} from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageCache';
import { openProviderAccountUsageSnapshot } from '@/sync/domains/connectedServices/accountUsage/openProviderAccountUsageSnapshot';
import {
    computeConnectedServiceQuotaErrorBackoffMs,
} from '@/sync/domains/connectedServices/connectedServiceQuotaErrorBackoff';
import {
    buildProviderAccountUsageScopeKey,
    readProviderAccountUsageSnapshotForMode,
} from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageLoadRoute';
import {
    normalizeProviderAccountUsageRecordIds,
    resolveProviderAccountUsageSnapshotState,
} from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageSelectors';
import type {
    ExpectedActiveServerFetchBasis,
} from '@/sync/http/client';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type {
    ProviderAccountUsageRecordId,
    ProviderAccountUsageSnapshotV1,
    ProviderAccountUsageStateV1,
} from '@happier-dev/protocol';
import { useCredentialScopedAccountModeResolver, type CredentialScopedAccountMode } from './useCredentialScopedAccountModeResolver';

export type ProviderAccountUsageSnapshotsFetchPolicy = 'poll' | 'cache_only';

export type ProviderAccountUsageSnapshotsResult = Readonly<{
    snapshotsByRecordId: Readonly<Record<string, ProviderAccountUsageSnapshotV1 | null>>;
    loadingByRecordId: Readonly<Record<string, boolean>>;
    stateByRecordId: Readonly<Record<string, ProviderAccountUsageStateV1>>;
}>;

const PROVIDER_ACCOUNT_USAGE_POLL_MS = 30_000;
const PROVIDER_ACCOUNT_USAGE_MISS_RETRY_MS = 30_000;

function buildRecordIdsSignature(recordIds: ReadonlyArray<string>): string {
    return normalizeProviderAccountUsageRecordIds(recordIds).join('\u0001');
}

async function readProviderAccountUsageSnapshot(params: Readonly<{
    credentials: NonNullable<ReturnType<typeof useAuth>['credentials']>;
    mode: CredentialScopedAccountMode;
    recordId: ProviderAccountUsageRecordId;
    signal: AbortSignal;
    serverBasis: ExpectedActiveServerFetchBasis;
}>): Promise<ProviderAccountUsageSnapshotV1 | null> {
    return await readProviderAccountUsageSnapshotForMode({
        mode: params.mode,
        readPlain: () => getProviderAccountUsageSnapshotPlain(
            params.credentials,
            { recordId: params.recordId },
            {
                signal: params.signal,
                expectedActiveServer: params.serverBasis,
            },
        ),
        readSealed: () => getProviderAccountUsageSnapshotSealed(
            params.credentials,
            { recordId: params.recordId },
            {
                signal: params.signal,
                expectedActiveServer: params.serverBasis,
            },
        ),
        openSealed: (sealed) => openProviderAccountUsageSnapshot(
            params.credentials,
            sealed.sealed,
        ),
    });
}

export function useProviderAccountUsageSnapshots(
    recordIds: ReadonlyArray<string>,
    options: Readonly<{ fetchPolicy?: ProviderAccountUsageSnapshotsFetchPolicy }> = {},
): ProviderAccountUsageSnapshotsResult {
    const auth = useAuth();
    const credentials = auth.credentials;
    const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
    const activeServer = useActiveServerSnapshot();
    const credentialScope =
        quotasEnabled && credentials
            ? buildProviderAccountUsageScopeKey({
                serverId: activeServer.serverId,
                generation: activeServer.generation,
                credentialScope:
                    resolveAuthCredentialsScopeKey(credentials),
            })
            : '';
    const fetchPolicy = options.fetchPolicy ?? 'poll';
    const [wakeSeq, setWakeSeq] = React.useState(0);
    const cacheState = React.useSyncExternalStore(
        subscribeProviderAccountUsageCache,
        getProviderAccountUsageCacheState,
        getProviderAccountUsageCacheState,
    );
    const cacheByRecordId = credentialScope ? cacheState.entriesByCredentialScope[credentialScope] ?? {} : {};
    const cacheStateRef = React.useRef({ credentialScope, entries: cacheByRecordId });

    React.useEffect(() => {
        cacheStateRef.current = { credentialScope, entries: cacheByRecordId };
    }, [cacheByRecordId, credentialScope]);

    const recordIdsSignature = React.useMemo(() => buildRecordIdsSignature(recordIds), [recordIds]);
    const normalizedRecordIds = React.useMemo(() => normalizeProviderAccountUsageRecordIds(recordIds), [recordIdsSignature]);
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
        if (
            fetchPolicy === 'cache_only'
            || !quotasEnabled
            || !credentials
            || !activeServer.serverId
            || normalizedRecordIds.length === 0
        ) return;

        const now = Date.now();
        let nextWakeAtMs = Number.POSITIVE_INFINITY;
        let hasMissingCache = false;
        for (const recordId of normalizedRecordIds) {
            const cached = cacheByRecordId[recordId];
            if (!cached) {
                hasMissingCache = true;
                continue;
            }
            nextWakeAtMs = Math.min(nextWakeAtMs, cached.nextFetchAtMs);
        }
        if (hasMissingCache || !Number.isFinite(nextWakeAtMs)) return;

        const delayMs = Math.max(0, nextWakeAtMs - now);
        const handle = setTimeout(() => setWakeSeq((value) => value + 1), delayMs);
        return () => clearTimeout(handle);
    }, [cacheByRecordId, credentials, fetchPolicy, normalizedRecordIds, quotasEnabled, wakeSeq]);

    React.useEffect(() => {
        if (fetchPolicy === 'cache_only' || !quotasEnabled || !credentials || normalizedRecordIds.length === 0) return;

        const now = Date.now();
        const toFetch = normalizedRecordIds.filter((recordId) => {
            const cacheSnapshot = cacheStateRef.current;
            const cached = cacheSnapshot.credentialScope === credentialScope
                ? cacheSnapshot.entries[recordId]
                : undefined;
            if (!cached) return true;
            if (cached.loading) return false;
            return now >= cached.nextFetchAtMs;
        });
        if (toFetch.length === 0) return;

        updateProviderAccountUsageCacheEntries(credentialScope, (entries) => {
            const next = { ...entries };
            for (const recordId of toFetch) {
                const existing = entries[recordId];
                next[recordId] = {
                    snapshot: existing?.snapshot ?? null,
                    nextFetchAtMs: existing?.nextFetchAtMs ?? now,
                    consecutiveErrors: existing?.consecutiveErrors ?? 0,
                    loading: true,
                    hadError: false,
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
                await Promise.all(toFetch.map(async (recordId) => {
                    try {
                        const opened = await readProviderAccountUsageSnapshot({
                            credentials,
                            mode,
                            recordId,
                            signal: controller.signal,
                            serverBasis: {
                                serverId: activeServer.serverId,
                                generation: activeServer.generation,
                            },
                        });
                        if (controller.signal.aborted || activeCredentialScopeRef.current !== requestCredentialScope) return;

                        updateProviderAccountUsageCacheEntries(requestCredentialScope, (entries) => ({
                            ...entries,
                            [recordId]: {
                                snapshot: opened,
                                nextFetchAtMs: opened
                                    ? now + Math.max(
                                        PROVIDER_ACCOUNT_USAGE_POLL_MS,
                                        Math.trunc(opened.staleAfterMs ?? PROVIDER_ACCOUNT_USAGE_POLL_MS),
                                    )
                                    : now + PROVIDER_ACCOUNT_USAGE_MISS_RETRY_MS,
                                consecutiveErrors: 0,
                                loading: false,
                                hadError: false,
                            },
                        }));
                    } catch {
                        if (controller.signal.aborted || activeCredentialScopeRef.current !== requestCredentialScope) return;
                        updateProviderAccountUsageCacheEntries(requestCredentialScope, (entries) => {
                            const existing = entries[recordId];
                            const consecutiveErrors = (existing?.consecutiveErrors ?? 0) + 1;
                            return {
                                ...entries,
                                [recordId]: {
                                    snapshot: existing?.snapshot ?? null,
                                    nextFetchAtMs: now
                                        + computeConnectedServiceQuotaErrorBackoffMs(
                                            consecutiveErrors,
                                        ),
                                    consecutiveErrors,
                                    loading: false,
                                    hadError: Boolean(existing?.snapshot),
                                },
                            };
                        });
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
    }, [
        activeServer.generation,
        activeServer.serverId,
        credentialScope,
        credentials,
        fetchPolicy,
        normalizedRecordIds,
        quotasEnabled,
        resolveAccountMode,
        wakeSeq,
    ]);

    return React.useMemo(() => {
        if (!quotasEnabled) {
            return {
                snapshotsByRecordId: {},
                loadingByRecordId: {},
                stateByRecordId: {},
            } satisfies ProviderAccountUsageSnapshotsResult;
        }

        const nowMs = Date.now();
        const snapshotsByRecordId: Record<string, ProviderAccountUsageSnapshotV1 | null> = {};
        const loadingByRecordId: Record<string, boolean> = {};
        const stateByRecordId: Record<string, ProviderAccountUsageStateV1> = {};
        for (const recordId of normalizedRecordIds) {
            const cached = cacheByRecordId[recordId];
            snapshotsByRecordId[recordId] = cached?.snapshot ?? null;
            loadingByRecordId[recordId] = cached?.loading ?? false;
            stateByRecordId[recordId] = resolveProviderAccountUsageSnapshotState({
                snapshot: cached?.snapshot ?? null,
                loading: cached?.loading ?? false,
                hadError: cached?.hadError ?? false,
                nowMs,
            });
        }

        return {
            snapshotsByRecordId,
            loadingByRecordId,
            stateByRecordId,
        } satisfies ProviderAccountUsageSnapshotsResult;
    }, [cacheByRecordId, normalizedRecordIds, quotasEnabled]);
}
