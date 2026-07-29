import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import {
    useServerFeaturesRuntimeSnapshot,
} from '@/sync/domains/features/featureDecisionRuntime';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import {
    resolveBuiltInConnectedAccountQuotaTransport,
    type BuiltInConnectedAccountQuotaNegotiation,
} from '@/sync/domains/connectedServices/resolveBuiltInConnectedAccountQuotaTransport';
import { useProfile } from '@/sync/store/hooks';

import type {
    BuiltInLegacyConnectedAccountOperation,
    ConnectedServiceQuotaSnapshotV1,
    QualifiedConnectedAccountQuotaSnapshotV4,
} from '@happier-dev/protocol';
import {
    ConnectedServiceIdSchema,
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

export type ConnectedServiceQuotaProfileRef = Readonly<{
    serviceId: string;
    profileId: string;
}>;

type NormalizedProfileRef = Readonly<{
    key: string;
    serviceId: ConnectedServiceId;
    profileId: string;
}>;

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
    serviceId: ConnectedServiceId;
    profileId: string;
    loadContext: QualifiedQuotaSnapshotStoreContext;
}>;

type QuotaRegistration =
    | LegacyQuotaRegistration
    | QualifiedQuotaRegistration;

export type ConnectedServiceQuotaSnapshotsResult = Readonly<{
    snapshotsByKey: Readonly<Record<string, ConnectedServiceQuotaSnapshotV1 | null>>;
    loadingByKey: Readonly<Record<string, boolean>>;
}>;

export type ConnectedServiceQuotaSnapshotsFetchPolicy = 'poll' | 'cache_only';

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

function resolveQuotaNegotiation(
    snapshot: ReturnType<typeof useServerFeaturesRuntimeSnapshot>,
): BuiltInConnectedAccountQuotaNegotiation {
    if (snapshot.status === 'loading') return 'indeterminate';
    if (snapshot.status === 'ready') {
        return snapshot.features.capabilities.connectedServices
            .qualifiedAccounts?.protocolVersion === 4
            ? 'advertised-v4'
            : 'legacy';
    }
    return snapshot.status === 'unsupported'
        && snapshot.reason === 'endpoint_missing'
        ? 'legacy'
        : 'indeterminate';
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
    profiles: ReadonlyArray<ConnectedServiceQuotaProfileRef>,
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

    const profilesSignature = React.useMemo(() => buildProfilesSignature(profiles), [profiles]);
    const normalizedProfiles = React.useMemo(() => normalizeProfileRefs(profiles), [profilesSignature]);
    const negotiation = resolveQuotaNegotiation(serverFeatures);
    const loadContexts = React.useMemo(() => {
        if (!quotasEnabled || !credentials || !activeServer.serverId) {
            return [] as ReadonlyArray<QuotaRegistration>;
        }
        return normalizedProfiles.flatMap<QuotaRegistration>(
            (quotaProfile) => {
            const transport =
                resolveBuiltInConnectedAccountQuotaTransport({
                    negotiation,
                    profile: quotaProfile,
                    qualifiedAccounts: profile.connectedAccountsV4,
                });
            if (!transport) return [];
            const serverBasis = {
                serverId: activeServer.serverId,
                generation: activeServer.generation,
            };
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
                    serviceId: quotaProfile.serviceId,
                    profileId: quotaProfile.profileId,
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
        const snapshotsByKey: Record<string, ConnectedServiceQuotaSnapshotV1 | null> = {};
        const loadingByKey: Record<string, boolean> = {};
        if (!quotasEnabled) {
            return { snapshotsByKey, loadingByKey } satisfies ConnectedServiceQuotaSnapshotsResult;
        }

        void version;
        for (const registration of loadContexts) {
            if (registration.kind === 'v4') {
                const entry =
                    getQualifiedQuotaSnapshotEntry(registration.key);
                snapshotsByKey[registration.profileKey] = entry.snapshot
                    ? projectQualifiedQuotaForLegacyUi({
                        snapshot: entry.snapshot,
                        serviceId: registration.serviceId,
                        profileId: registration.profileId,
                    })
                    : null;
                loadingByKey[registration.profileKey] = entry.loading;
                continue;
            }
            const entry = getQuotaSnapshotEntry(registration.key);
            snapshotsByKey[registration.profileKey] = entry.snapshot;
            loadingByKey[registration.profileKey] = entry.loading;
        }

        return { snapshotsByKey, loadingByKey } satisfies ConnectedServiceQuotaSnapshotsResult;
    }, [loadContexts, quotasEnabled, version]);
}
