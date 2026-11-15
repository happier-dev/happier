import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useShallow } from 'zustand/react/shallow';

import { getCurrentAuth, useAuth } from '@/auth/context/AuthContext';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    getProviderAccountUsageSnapshotPlain,
    getProviderAccountUsageSnapshotSealed,
} from '@/sync/api/account/apiProviderAccountUsage';
import {
    getProviderAccountUsageCacheState,
    retainProviderAccountUsageCacheEntries,
    subscribeProviderAccountUsageCache,
    updateProviderAccountUsageCacheEntries,
    type ProviderAccountUsageCacheEntry,
    type ProviderAccountUsageCacheState,
} from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageCache';
import { openProviderAccountUsageSnapshot } from '@/sync/domains/connectedServices/accountUsage/openProviderAccountUsageSnapshot';
import { observeUsageProjection } from '@/sync/api/account/usageQueryInvalidation';
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
import { HappyError } from '@/utils/errors/errors';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

import type {
    ProviderAccountUsageRecordId,
    ProviderAccountUsageSnapshotV1,
    ProviderAccountUsageStateV1,
} from '@happier-dev/protocol/connect/account-usage-primitives';
import { useCredentialScopedAccountModeResolver, type CredentialScopedAccountMode } from './useCredentialScopedAccountModeResolver';

export type ProviderAccountUsageSnapshotsFetchPolicy = 'poll' | 'cache_only';

const noSubscription = () => () => {};

export type ProviderAccountUsageSnapshotsResult = Readonly<{
    snapshotsByRecordId: Readonly<Record<string, ProviderAccountUsageSnapshotV1 | null>>;
    loadingByRecordId: Readonly<Record<string, boolean>>;
    stateByRecordId: Readonly<Record<string, ProviderAccountUsageStateV1>>;
}>;

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
                retry: 'none',
            },
        ),
        readSealed: () => getProviderAccountUsageSnapshotSealed(
            params.credentials,
            { recordId: params.recordId },
            {
                signal: params.signal,
                expectedActiveServer: params.serverBasis,
                retry: 'none',
            },
        ),
        openSealed: (response) => {
            const snapshot = openProviderAccountUsageSnapshot(
                params.credentials,
                response.content,
            );
            return snapshot?.recordId === params.recordId ? snapshot : null;
        },
    });
}
/** The existing cache retain owner shares one acquisition per credential-scoped record. */
function createUsageRowObserver(input: Readonly<{
    credentials: NonNullable<ReturnType<typeof useAuth>['credentials']>;
    credentialScope: string;
    serverBasis: ExpectedActiveServerFetchBasis;
    resolveAccountMode(): Promise<CredentialScopedAccountMode>;
    isCurrent(): boolean;
}>) {
    type Outcome = Readonly<{
        recordId: string;
        entry: ProviderAccountUsageCacheEntry;
        current(): boolean;
    }>;
    let outcomes: Outcome[] = [];
    let publicationScheduled = false;
    const publish = () => {
        publicationScheduled = false;
        const currentOutcomes = outcomes.filter(outcome => outcome.current());
        outcomes = [];
        if (currentOutcomes.length === 0) return;
        updateProviderAccountUsageCacheEntries(input.credentialScope, entries => {
            const next = { ...entries };
            for (const outcome of currentOutcomes) next[outcome.recordId] = outcome.entry;
            return next;
        });
    };
    const enqueue = (outcome: Outcome) => {
        outcomes.push(outcome);
        if (!publicationScheduled) { publicationScheduled = true; queueMicrotask(publish); }
    };
    return (recordId: string): (() => void) => {
        let disposed = false;
        let controller: AbortController | null = null;
        let reading: Promise<void> | null = null;
        const readEntry = () => getProviderAccountUsageCacheState().entriesByCredentialScope[input.credentialScope]?.[recordId];
        const current = () => !disposed && input.isCurrent();
        const observation = observeUsageProjection({
            serverId: input.serverBasis.serverId,
            readRecordId: () => recordId,
            busy: () => reading !== null || !current(),
            nextReadAtMs: () => readEntry()?.nextFetchAtMs ?? Number.POSITIVE_INFINITY,
            presentationDeadlineMs: () => {
                const snapshot = readEntry()?.snapshot;
                return snapshot ? snapshot.fetchedAtMs + snapshot.staleAfterMs + 1 : undefined;
            },
            publish: () => { if (current()) updateProviderAccountUsageCacheEntries(input.credentialScope, entries => entries); },
            read() {
                if (reading) return reading;
                if (!current()) return Promise.resolve();
                const previous = readEntry();
                enqueue({ recordId, current, entry: { snapshot: previous?.snapshot ?? null,
                        nextFetchAtMs: previous?.nextFetchAtMs ?? 0,
                        loading: true, hadError: previous?.hadError ?? false } });
                const requestController = new AbortController();
                controller = requestController;
                reading = (async () => {
                    let entry: Outcome['entry'];
                    try {
                        const mode = await input.resolveAccountMode();
                        if (!current()) return;
                        const opened = await readProviderAccountUsageSnapshot({ ...input, mode, recordId,
                            signal: requestController.signal });
                        entry = { snapshot: opened, nextFetchAtMs: Number.POSITIVE_INFINITY,
                            loading: false, hadError: false };
                    } catch (error) {
                        if (!current()) return;
                        const denied = error instanceof HappyError && (error.status === 401 || error.status === 403);
                        entry = { snapshot: denied ? null : previous?.snapshot ?? null,
                            nextFetchAtMs: Number.POSITIVE_INFINITY,
                            loading: false, hadError: !denied && Boolean(previous?.snapshot) };
                    } finally {
                        reading = null;
                        controller = null;
                    }
                    if (!current()) return;
                    enqueue({ recordId, entry, current });
                })();
                return reading;
            },
        });
        return () => {
            disposed = true;
            observation.dispose();
            controller?.abort();
        };
    };
}

export function useProviderAccountUsageSnapshots(
    recordIds: ReadonlyArray<string>,
    options: Readonly<{
        fetchPolicy?: ProviderAccountUsageSnapshotsFetchPolicy;
        /**
         * Whether this reader presents in-flight revalidation (`loadingByRecordId`). Only such readers
         * render for a loading flip; every other reader renders only for a usage, error or row change.
         */
        loading?: boolean;
    }> = {},
): ProviderAccountUsageSnapshotsResult {
    const presented = useLayoutPresentationActive();
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
    const activeCredentialScopeRef = React.useRef(credentialScope);
    activeCredentialScopeRef.current = credentialScope;
    const recordIdsSignature = React.useMemo(() => buildRecordIdsSignature(recordIds), [recordIds]);
    const normalizedRecordIds = React.useMemo(() => normalizeProviderAccountUsageRecordIds(recordIds), [recordIdsSignature]);
    const presentsLoading = options.loading === true;
    // Select presentation facts, not cache rows: a row object also changes for scheduling
    // (`nextFetchAtMs`) and in-flight activity that this reader may not present.
    const selectEntries = useShallow((state: ProviderAccountUsageCacheState) => {
        const entries = state.entriesByCredentialScope[credentialScope];
        const selected: Record<string, unknown> = {};
        // Equal data ages into a different presentation at its deadline; the owner publishes then.
        const nowMs = Date.now();
        for (const recordId of normalizedRecordIds) {
            const entry = entries?.[recordId];
            selected[`${recordId}\u0000snapshot`] = entry?.snapshot ?? null;
            selected[`${recordId}\u0000state`] = resolveProviderAccountUsageSnapshotState({
                snapshot: entry?.snapshot ?? null, loading: entry?.loading ?? false, hadError: entry?.hadError ?? false, nowMs,
            });
            if (presentsLoading) selected[`${recordId}\u0000loading`] = entry?.loading ?? false;
        }
        return selected;
    });
    const readSelectedEntries = () => selectEntries(getProviderAccountUsageCacheState());
    const cacheByRecordId = React.useSyncExternalStore(
        presented ? subscribeProviderAccountUsageCache : noSubscription,
        readSelectedEntries,
        readSelectedEntries,
    );
    const resolveAccountMode = useCredentialScopedAccountModeResolver({ credentials, credentialScope });

    // Presentation retention survives changing acquisition policy or its observer.
    React.useEffect(() => retainProviderAccountUsageCacheEntries(
        credentialScope, normalizedRecordIds,
    ), [credentialScope, normalizedRecordIds]);

    React.useEffect(() => retainProviderAccountUsageCacheEntries(
        credentialScope,
        normalizedRecordIds,
        presented && fetchPolicy !== 'cache_only' && quotasEnabled && credentials && activeServer.serverId
            ? createUsageRowObserver({ credentials, credentialScope, resolveAccountMode,
                isCurrent: () => {
                    if (activeCredentialScopeRef.current !== credentialScope) return false;
                    const currentServer = getActiveServerSnapshot();
                    const currentCredentials = getCurrentAuth()?.credentials;
                    return currentServer.generation === activeServer.generation
                        && areServerProfileIdentifiersEquivalent(currentServer.serverId, activeServer.serverId)
                        && Boolean(currentCredentials && resolveAuthCredentialsScopeKey(currentCredentials)
                            === resolveAuthCredentialsScopeKey(credentials));
                },
                serverBasis: { serverId: activeServer.serverId, generation: activeServer.generation } })
            : undefined,
    ), [credentialScope, normalizedRecordIds, fetchPolicy, quotasEnabled, credentials, presented,
        activeServer.serverId, activeServer.generation, resolveAccountMode]);

    return React.useMemo(() => {
        if (!quotasEnabled) {
            return {
                snapshotsByRecordId: {},
                loadingByRecordId: {},
                stateByRecordId: {},
            } satisfies ProviderAccountUsageSnapshotsResult;
        }

        const snapshotsByRecordId: Record<string, ProviderAccountUsageSnapshotV1 | null> = {};
        const loadingByRecordId: Record<string, boolean> = {};
        const stateByRecordId: Record<string, ProviderAccountUsageStateV1> = {};
        for (const recordId of normalizedRecordIds) {
            const snapshot = (cacheByRecordId[`${recordId}\u0000snapshot`] ?? null) as ProviderAccountUsageSnapshotV1 | null;
            const loading = cacheByRecordId[`${recordId}\u0000loading`] === true;
            snapshotsByRecordId[recordId] = snapshot;
            loadingByRecordId[recordId] = loading;
            stateByRecordId[recordId] = cacheByRecordId[`${recordId}\u0000state`] as ProviderAccountUsageStateV1;
        }

        return {
            snapshotsByRecordId,
            loadingByRecordId,
            stateByRecordId,
        } satisfies ProviderAccountUsageSnapshotsResult;
    }, [cacheByRecordId, normalizedRecordIds, quotasEnabled]);
}
