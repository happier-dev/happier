import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    ConnectedServiceIdSchema,
    ConnectedServiceProfileIdSchema,
    type ConnectedServiceId,
    type QualifiedConnectedAccountProfileV4,
    type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

export type BuiltInConnectedAccountQuotaNegotiation =
    | 'advertised-v4'
    | 'legacy'
    | 'indeterminate';

type LegacyQuotaProfile = Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
}>;

export type BuiltInConnectedAccountQuotaTransport =
    | Readonly<{
        kind: 'v4';
        legacyProfile: LegacyQuotaProfile;
        ref: QualifiedConnectedAccountRef;
    }>
    | Readonly<{
        kind: 'legacy';
        legacyProfile: LegacyQuotaProfile;
    }>;

function sameQualifiedService(
    left: QualifiedConnectedAccountRef['service'],
    right: QualifiedConnectedAccountRef['service'],
): boolean {
    return left.pluginId === right.pluginId
        && left.localId === right.localId;
}

/**
 * Selects the one quota transport for a legacy built-in UI profile.
 *
 * Advertised V4 is authoritative: its exact qualified profile must be present,
 * and absence never downgrades to a legacy request. Legacy operation support is
 * rechecked by the daemon immediately before the compatibility effect.
 */
export function resolveBuiltInConnectedAccountQuotaTransport(params: Readonly<{
    negotiation: BuiltInConnectedAccountQuotaNegotiation;
    profile: Readonly<{
        serviceId: string;
        profileId: string;
    }>;
    qualifiedAccounts: readonly QualifiedConnectedAccountProfileV4[];
}>): BuiltInConnectedAccountQuotaTransport | null {
    const serviceId = ConnectedServiceIdSchema.safeParse(
        String(params.profile.serviceId ?? '').trim(),
    );
    const profileId = ConnectedServiceProfileIdSchema.safeParse(
        String(params.profile.profileId ?? '').trim(),
    );
    if (!serviceId.success || !profileId.success) return null;

    const legacyProfile = {
        serviceId: serviceId.data,
        profileId: profileId.data,
    } satisfies LegacyQuotaProfile;

    if (params.negotiation === 'indeterminate') return null;
    if (params.negotiation === 'legacy') {
        return {
            kind: 'legacy',
            legacyProfile,
        };
    }

    const expectedService =
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
            legacyProfile.serviceId
        ].service;
    const account = params.qualifiedAccounts.find((candidate) => (
        candidate.ref.accountId === legacyProfile.profileId
        && sameQualifiedService(candidate.ref.service, expectedService)
    ));
    if (!account) return null;

    return {
        kind: 'v4',
        legacyProfile,
        ref: account.ref,
    };
}
