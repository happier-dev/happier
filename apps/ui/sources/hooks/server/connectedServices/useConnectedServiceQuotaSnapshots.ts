import * as React from 'react';

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

import type {
    BuiltInLegacyConnectedAccountOperation,
    ConnectedServiceQuotaSnapshotV1,
    QualifiedConnectedAccountQuotaSnapshotV4,
} from '@happier-dev/protocol';
import {
    ConnectedServiceQuotaSnapshotV1Schema,
    type ConnectedServiceId,
} from '@happier-dev/protocol';
import { useCredentialScopedAccountModeResolver } from './useCredentialScopedAccountModeResolver';
import {
    buildQuotaSnapshotScopeKey,
    getQuotaSnapshotEntry,
    retainQuotaSnapshotPolling,
    subscribeQuotaSnapshotEntry,
    type QuotaSnapshotLoadContext,
} from './connectedServiceQuotaSnapshotStore';
import {
    buildQualifiedQuotaSnapshotScopeKey,
    getQualifiedQuotaSnapshotEntry,
    retainQualifiedQuotaSnapshotPolling,
    subscribeQualifiedQuotaSnapshotEntry,
    type QualifiedQuotaSnapshotStoreContext,
} from './qualifiedConnectedAccountQuotaSnapshotStore';
import {
    useConnectedAccountOperationAdmission,
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
     * The normalized refs this hook actually polls, in the canonical order.
     *
     * Callers that need the same keyed refs (badge and summary projections)
     * read them from here instead of normalizing the same input a second time.
     */
    profiles: ReadonlyArray<NormalizedConnectedServiceQuotaProfileRef>;
    snapshotsByKey: Readonly<Record<string, ConnectedServiceQuotaSnapshotForUi | null>>;
    loadingByKey: Readonly<Record<string, boolean>>;
}>;

type LegacyConnectedServiceQuotaSnapshotsResult = Readonly<{
    profiles: ReadonlyArray<NormalizedLegacyConnectedServiceQuotaProfileRef>;
    snapshotsByKey: Readonly<Record<string, ConnectedServiceQuotaSnapshotV1 | null>>;
    loadingByKey: Readonly<Record<string, boolean>>;
}>;

export type ConnectedServiceQuotaSnapshotsFetchPolicy = 'poll' | 'cache_only';

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
    const auth = useAuth();
    const credentials = auth.credentials;
    const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
    const activeServer = useActiveServerSnapshot();
    const serverFeatures = useServerFeaturesRuntimeSnapshot({
        enabled: quotasEnabled,
    });
    const profile = useProfile();
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
    const assertQualifiedOperationAllowed =
        useConnectedAccountOperationAdmission();

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
    const loadContexts = React.useMemo(() => {
        if (!quotasEnabled || !credentials || !activeServer.serverId) {
            return [] as ReadonlyArray<QuotaRegistration>;
        }
        return normalizedProfiles.flatMap<QuotaRegistration>(
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
                    assertOperationAllowed: (
                        operation: BuiltInLegacyConnectedAccountOperation,
                    ) => assertQualifiedOperationAllowed(
                        quotaProfile.ref.service,
                        { kind: 'v4' },
                        operation,
                    ),
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
                    assertOperationAllowed: (
                        operation:
                            BuiltInLegacyConnectedAccountOperation,
                    ) =>
                        assertQualifiedOperationAllowed(
                            transport.ref.service,
                            { kind: 'v4' },
                            operation,
                        ),
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
                    assertOperationAllowed: (
                        operation:
                            BuiltInLegacyConnectedAccountOperation,
                    ) =>
                        assertLegacyOperationAllowed(
                            quotaProfile.serviceId,
                            operation,
                        ),
                },
            }];
            },
        );
    }, [
        assertLegacyOperationAllowed,
        assertQualifiedOperationAllowed,
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
        if (loadContexts.length === 0) return;
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
    }, [loadContexts]);

    React.useEffect(() => {
        if (fetchPolicy === 'cache_only') return;
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
    }, [fetchPolicy, loadContexts]);

    return React.useMemo(() => {
        const snapshotsByKey: Record<string, ConnectedServiceQuotaSnapshotForUi | null> = {};
        const loadingByKey: Record<string, boolean> = {};
        if (!quotasEnabled) {
            return {
                profiles: normalizedProfiles,
                snapshotsByKey,
                loadingByKey,
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
                continue;
            }
            const entry = getQuotaSnapshotEntry(registration.key);
            snapshotsByKey[registration.profileKey] = entry.snapshot;
            loadingByKey[registration.profileKey] = entry.loading;
        }

        return {
            profiles: normalizedProfiles,
            snapshotsByKey,
            loadingByKey,
        } satisfies ConnectedServiceQuotaSnapshotsResult;
    }, [loadContexts, normalizedProfiles, quotasEnabled, version]);
}
