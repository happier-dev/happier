import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import { useAuth } from '@/auth/context/AuthContext';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import {
    useServerFeaturesRuntimeSnapshot,
} from '@/sync/domains/features/featureDecisionRuntime';
import {
    normalizeConnectedServiceQuotaProfileRefs,
    type ConnectedServiceQuotaProfileRefInput,
    type LegacyConnectedServiceQuotaProfileRefInput,
    type NormalizedConnectedServiceQuotaProfileRef,
    type NormalizedLegacyConnectedServiceQuotaProfileRef,
} from '@/sync/domains/connectedServices/connectedServiceQuotaProfileRefs';
import {
    resolveBuiltInConnectedAccountQuotaTransport,
    type BuiltInConnectedAccountQuotaNegotiation,
} from '@/sync/domains/connectedServices/resolveBuiltInConnectedAccountQuotaTransport';
import {
    resolveConnectedAccountUiNegotiation,
} from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import { useProfile } from '@/sync/store/hooks';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';

import type {
    ConnectedServiceQuotaSnapshotV1,
    ProviderAccountUsageRecordId,
    QualifiedConnectedAccountQuotaSnapshotV4,
} from '@happier-dev/protocol';
import { ConnectedServiceQuotaSnapshotV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import { useCredentialScopedAccountModeResolver } from './useCredentialScopedAccountModeResolver';
import {
    buildQuotaSnapshotScopeKey,
    getQuotaSnapshotEntry,
    refreshQuotaSnapshot,
    retainQuotaSnapshotOnce,
    retainQuotaSnapshotPolling,
    subscribeQuotaSnapshotEntry,
    type QuotaSnapshotLoadContext,
} from './connectedServiceQuotaSnapshotStore';
import {
    buildQualifiedQuotaSnapshotScopeKey,
    getQualifiedQuotaSnapshotEntry,
    loadQualifiedQuotaSnapshotOnce,
    refreshQualifiedQuotaSnapshot,
    retainQualifiedQuotaSnapshotPolling,
    subscribeQualifiedQuotaSnapshotEntry,
    type QualifiedQuotaSnapshotStoreContext,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import {
    useConnectedServiceLegacyOperationAdmission,
} from './useConnectedServiceLegacyOperationAdmission';

type LegacyQuotaRegistration = Readonly<{
    kind: 'legacy';
    key: string;
    profileKey: string;
    loadContext: QuotaSnapshotLoadContext;
}>;

type QualifiedQuotaRegistration = Readonly<{
    kind: 'v4';
    key: string;
    profileKey: string;
    /** Present only when a released scalar caller is projected through V4. */
    legacyProfile?: Readonly<{
        serviceId: ConnectedServiceId;
        profileId: string;
    }>;
    loadContext: QualifiedQuotaSnapshotStoreContext;
}>;

type QuotaRegistration =
    | LegacyQuotaRegistration
    | QualifiedQuotaRegistration;

export type ConnectedServiceQuotaSnapshotForUi =
    | ConnectedServiceQuotaSnapshotV1
    | QualifiedConnectedAccountQuotaSnapshotV4;

export type ConnectedServiceQuotaSnapshotsResult = Readonly<{
    /**
     * The normalized refs this hook observes, in the canonical order.
     *
     * Callers that need the same keyed refs (badge and summary projections)
     * read them from here instead of normalizing the same input a second time.
     */
    profiles: ReadonlyArray<NormalizedConnectedServiceQuotaProfileRef>;
    snapshotsByKey: Readonly<Record<string, ConnectedServiceQuotaSnapshotForUi | null>>;
    /** Canonical PAU record ids from opened V4 responses; absent for legacy quota transport. */
    usageRecordIdsByKey: Readonly<Record<string, ProviderAccountUsageRecordId | null>>;
    loadingByKey: Readonly<Record<string, boolean>>;
    /** A read of this account completed (with or without a snapshot). */
    readByKey: Readonly<Record<string, boolean>>;
    refreshingByKey: Readonly<Record<string, boolean>>;
    errorsByKey: Readonly<Record<string, string | null>>;
    refreshableKeys: readonly string[];
    /** Refresh only the selected accounts, or all admitted accounts when keys are omitted. */
    refresh(keys?: readonly string[]): Promise<void>;
}>;

type LegacyConnectedServiceQuotaSnapshotsResult = Readonly<{
    profiles: ReadonlyArray<NormalizedLegacyConnectedServiceQuotaProfileRef>;
    snapshotsByKey: Readonly<Record<string, ConnectedServiceQuotaSnapshotV1 | null>>;
    usageRecordIdsByKey: Readonly<Record<string, ProviderAccountUsageRecordId | null>>;
    loadingByKey: Readonly<Record<string, boolean>>;
    readByKey: Readonly<Record<string, boolean>>;
    refreshingByKey: Readonly<Record<string, boolean>>;
    errorsByKey: Readonly<Record<string, string | null>>;
    refreshableKeys: readonly string[];
    refresh(keys?: readonly string[]): Promise<void>;
}>;

/**
 * `poll`: retain change-driven currentness while mounted, with foreground/reconnect and failed-read
 * catch-up. Negotiated predecessor transport also retains its acquisition cadence.
 * `once`: read once per launch if nothing was read yet, without retaining acquisition.
 * `cache_only`: never read; show what this launch already has.
 */
export type ConnectedServiceQuotaSnapshotsFetchPolicy = 'poll' | 'once' | 'cache_only';

function buildProfilesSignature(
    profiles: ReadonlyArray<NormalizedConnectedServiceQuotaProfileRef>,
): string {
    return profiles
        .map((profile) => profile.kind === 'legacy'
            ? `${profile.kind}\u0000${profile.key}\u0000${profile.serviceId}\u0000${profile.profileId}`
            : `${profile.kind}\u0000${profile.key}\u0000${profile.ref.service.pluginId}\u0000${profile.ref.service.localId}\u0000${profile.ref.accountId}`)
        .join('\u0001');
}

function projectQualifiedQuotaForLegacyUi(params: Readonly<{
    snapshot: QualifiedConnectedAccountQuotaSnapshotV4;
    serviceId: ConnectedServiceId;
    profileId: string;
}>): ConnectedServiceQuotaSnapshotV1 {
    const { ref: _qualifiedRef, ...quota } = params.snapshot;
    return ConnectedServiceQuotaSnapshotV1Schema.parse({
        ...quota,
        serviceId: params.serviceId,
        profileId: params.profileId,
    });
}

export function useConnectedServiceQuotaSnapshots(
    profiles: ReadonlyArray<LegacyConnectedServiceQuotaProfileRefInput>,
    options?: Readonly<{ fetchPolicy?: ConnectedServiceQuotaSnapshotsFetchPolicy }>,
): LegacyConnectedServiceQuotaSnapshotsResult;
export function useConnectedServiceQuotaSnapshots(
    profiles: ReadonlyArray<ConnectedServiceQuotaProfileRefInput>,
    options?: Readonly<{ fetchPolicy?: ConnectedServiceQuotaSnapshotsFetchPolicy }>,
): ConnectedServiceQuotaSnapshotsResult;
export function useConnectedServiceQuotaSnapshots(
    profiles: ReadonlyArray<ConnectedServiceQuotaProfileRefInput>,
    options: Readonly<{ fetchPolicy?: ConnectedServiceQuotaSnapshotsFetchPolicy }> = {},
): ConnectedServiceQuotaSnapshotsResult {
    const presented = useLayoutPresentationActive();
    const auth = useAuth();
    const credentials = auth.credentials;
    const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
    const activeServer = useActiveServerSnapshot();
    const serverFeatures = useServerFeaturesRuntimeSnapshot({
        enabled: quotasEnabled,
    });
    const profile = useProfile((profile) => ({ connectedAccountsV4: profile.connectedAccountsV4 }));
    const credentialScope =
        quotasEnabled && credentials && activeServer.serverId
            ? [
                activeServer.serverId,
                String(activeServer.generation),
                resolveAuthCredentialsScopeKey(credentials),
            ].join('\u0000')
            : '';
    const fetchPolicy = options.fetchPolicy ?? 'poll';
    const resolveAccountMode = useCredentialScopedAccountModeResolver({ credentials, credentialScope });
    const assertLegacyOperationAllowed =
        useConnectedServiceLegacyOperationAdmission();

    const normalizedInput = React.useMemo(
        () => normalizeConnectedServiceQuotaProfileRefs(profiles),
        [profiles],
    );
    const profilesSignature = React.useMemo(
        () => buildProfilesSignature(normalizedInput),
        [normalizedInput],
    );
    // Re-held by signature so a fresh input array carrying the same refs keeps
    // one identity, and every downstream memo/subscription stays stable.
    const normalizedProfiles = React.useMemo(() => normalizedInput, [profilesSignature]);
    const negotiation: BuiltInConnectedAccountQuotaNegotiation =
        resolveConnectedAccountUiNegotiation(serverFeatures);
    const publishedLoadContexts = React.useRef<ReadonlyArray<QuotaRegistration>>([]);
    const loadContexts = React.useMemo(() => {
        if (!quotasEnabled || !credentials || !activeServer.serverId) {
            publishedLoadContexts.current = retainKeyedRows(publishedLoadContexts.current, [], row => row.profileKey);
            return publishedLoadContexts.current;
        }
        const incoming = normalizedProfiles.flatMap<QuotaRegistration>(
            (quotaProfile) => {
            const serverBasis = {
                serverId: activeServer.serverId,
                generation: activeServer.generation,
            };
            if (quotaProfile.kind === 'qualified') {
                // A direct V4 ref has no scalar compatibility representation.
                // Never infer one or fall back when the server cannot prove V4.
                if (negotiation !== 'advertised-v4') return [];
                const loadContext: QualifiedQuotaSnapshotStoreContext = {
                    credentials,
                    credentialScope,
                    serverBasis,
                    ref: quotaProfile.ref,
                };
                return [{
                    kind: 'v4' as const,
                    key: buildQualifiedQuotaSnapshotScopeKey(loadContext),
                    profileKey: quotaProfile.key,
                    loadContext,
                }];
            }
            const transport =
                resolveBuiltInConnectedAccountQuotaTransport({
                    negotiation,
                    profile: quotaProfile,
                    qualifiedAccounts: profile.connectedAccountsV4,
            });
            if (!transport) return [];
            if (transport.kind === 'v4') {
                const loadContext: QualifiedQuotaSnapshotStoreContext = {
                    credentials,
                    credentialScope,
                    serverBasis,
                    ref: transport.ref,
                };
                return [{
                    kind: 'v4' as const,
                    key:
                        buildQualifiedQuotaSnapshotScopeKey(loadContext),
                    profileKey: quotaProfile.key,
                    legacyProfile: transport.legacyProfile,
                    loadContext,
                }];
            }
            return [{
                kind: 'legacy' as const,
                key: buildQuotaSnapshotScopeKey(
                    credentialScope,
                    quotaProfile.serviceId,
                    quotaProfile.profileId,
                ),
                profileKey: quotaProfile.key,
                loadContext: {
                    transport: 'legacy' as const,
                    credentials,
                    credentialScope,
                    serverBasis,
                    serviceId: quotaProfile.serviceId,
                    profileId: quotaProfile.profileId,
                    resolveAccountMode,
                },
            }];
            },
        );
        // Account activity may change without changing any admitted quota transport.
        // Publish the same registrations so existing observations keep their lifetime.
        publishedLoadContexts.current = retainKeyedRows(publishedLoadContexts.current, incoming, row => row.profileKey);
        return publishedLoadContexts.current;
    }, [
        activeServer.generation,
        activeServer.serverId,
        credentialScope,
        credentials,
        negotiation,
        normalizedProfiles,
        profile.connectedAccountsV4,
        quotasEnabled,
        resolveAccountMode,
    ]);
    const [version, bumpVersion] = React.useReducer((value: number) => value + 1, 0);

    React.useEffect(() => {
        if (!presented || loadContexts.length === 0) return;
        const unsubs = loadContexts.map((registration) =>
            registration.kind === 'v4'
                ? subscribeQualifiedQuotaSnapshotEntry(
                    registration.key,
                    bumpVersion,
                )
                : subscribeQuotaSnapshotEntry(
                    registration.key,
                    bumpVersion,
                ));
        return () => {
            for (const unsub of unsubs) unsub();
        };
    }, [loadContexts, presented]);

    React.useEffect(() => {
        if (!presented || fetchPolicy !== 'once') return;
        const releases = loadContexts.map((registration) =>
            registration.kind === 'v4'
                ? loadQualifiedQuotaSnapshotOnce(registration.key, registration.loadContext)
                : retainQuotaSnapshotOnce(registration.key, registration.loadContext));
        return () => {
            for (const release of releases) release();
        };
    }, [fetchPolicy, loadContexts, presented]);

    React.useEffect(() => {
        if (!presented || fetchPolicy !== 'poll') return;
        const releases = loadContexts.map((registration) =>
            registration.kind === 'v4'
                ? retainQualifiedQuotaSnapshotPolling(
                    registration.key,
                    registration.loadContext,
                )
                : retainQuotaSnapshotPolling(
                    registration.key,
                    registration.loadContext,
                ));
        return () => {
            for (const release of releases) release();
        };
    }, [fetchPolicy, loadContexts, presented]);

    const refresh = React.useCallback(async (keys?: readonly string[]) => {
        const selected = keys ? new Set(keys) : null;
        await Promise.all(loadContexts.filter((registration) => !selected || selected.has(registration.profileKey)).map((registration) => {
            if (registration.kind === 'v4') {
                if (getQualifiedQuotaSnapshotEntry(registration.key).supported === false) return;
                return refreshQualifiedQuotaSnapshot(registration.key, registration.loadContext);
            }
            return refreshQuotaSnapshot(registration.key, {
                ...registration.loadContext,
                assertOperationAllowed: (operation, signal) => assertLegacyOperationAllowed(
                    registration.loadContext.serviceId, operation, signal,
                ),
            });
        }));
    }, [assertLegacyOperationAllowed, loadContexts]);

    return React.useMemo(() => {
        const snapshotsByKey: Record<string, ConnectedServiceQuotaSnapshotForUi | null> = {};
        const usageRecordIdsByKey: Record<string, ProviderAccountUsageRecordId | null> = {};
        const loadingByKey: Record<string, boolean> = {};
        const readByKey: Record<string, boolean> = {};
        const refreshingByKey: Record<string, boolean> = {};
        const errorsByKey: Record<string, string | null> = {};
        const refreshableKeys: string[] = [];
        if (!quotasEnabled) {
            return {
                profiles: normalizedProfiles,
                snapshotsByKey,
                usageRecordIdsByKey,
                loadingByKey,
                readByKey,
                refreshingByKey,
                errorsByKey,
                refreshableKeys,
                refresh,
            } satisfies ConnectedServiceQuotaSnapshotsResult;
        }

        void version;
        for (const registration of loadContexts) {
            if (registration.kind === 'v4') {
                const entry =
                    getQualifiedQuotaSnapshotEntry(registration.key);
                snapshotsByKey[registration.profileKey] = entry.snapshot
                    ? registration.legacyProfile
                        ? projectQualifiedQuotaForLegacyUi({
                            snapshot: entry.snapshot,
                            serviceId: registration.legacyProfile.serviceId,
                            profileId: registration.legacyProfile.profileId,
                        })
                        : entry.snapshot
                    : null;
                loadingByKey[registration.profileKey] = entry.loading;
                usageRecordIdsByKey[registration.profileKey] = entry.usageRecordId;
                readByKey[registration.profileKey] = entry.read;
                refreshingByKey[registration.profileKey] = entry.refreshing;
                errorsByKey[registration.profileKey] = entry.error;
                if (entry.supported !== false) refreshableKeys.push(registration.profileKey);
                continue;
            }
            const entry = getQuotaSnapshotEntry(registration.key);
            snapshotsByKey[registration.profileKey] = entry.snapshot;
            usageRecordIdsByKey[registration.profileKey] = null;
            loadingByKey[registration.profileKey] = entry.loading;
            readByKey[registration.profileKey] = entry.read;
            refreshingByKey[registration.profileKey] = entry.refreshing;
            errorsByKey[registration.profileKey] = entry.error;
            refreshableKeys.push(registration.profileKey);
        }

        return {
            profiles: normalizedProfiles,
            snapshotsByKey,
            usageRecordIdsByKey,
            loadingByKey,
            readByKey,
            refreshingByKey,
            errorsByKey,
            refreshableKeys,
            refresh,
        } satisfies ConnectedServiceQuotaSnapshotsResult;
    }, [loadContexts, normalizedProfiles, presented, quotasEnabled, refresh, version]);
}
