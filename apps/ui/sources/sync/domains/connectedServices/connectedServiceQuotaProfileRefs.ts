import {
    buildQualifiedPluginContributionKey,
    ConnectedServiceIdSchema,
    QualifiedConnectedAccountRefSchema,
    type ConnectedServiceId,
    type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import { connectedServiceProfileKey } from './connectedServiceProfilePreferences';

/** A caller-supplied profile reference, before validation. */
export type LegacyConnectedServiceQuotaProfileRefInput = Readonly<{
    serviceId: string;
    profileId: string;
}>;

/** An exact V4 account reference. It never falls through the legacy enum. */
export type QualifiedConnectedServiceQuotaProfileRefInput = Readonly<{
    ref: QualifiedConnectedAccountRef;
}>;

export type ConnectedServiceQuotaProfileRefInput =
    | LegacyConnectedServiceQuotaProfileRefInput
    | QualifiedConnectedServiceQuotaProfileRefInput;

/** A validated, keyed profile reference every quota consumer can index by. */
export type NormalizedLegacyConnectedServiceQuotaProfileRef = Readonly<{
    kind: 'legacy';
    key: string;
    serviceId: ConnectedServiceId;
    profileId: string;
}>;

export type NormalizedQualifiedConnectedServiceQuotaProfileRef = Readonly<{
    kind: 'qualified';
    key: string;
    ref: QualifiedConnectedAccountRef;
}>;

export type NormalizedConnectedServiceQuotaProfileRef =
    | NormalizedLegacyConnectedServiceQuotaProfileRef
    | NormalizedQualifiedConnectedServiceQuotaProfileRef;

function normalizeConnectedServiceQuotaProfileRef(
    profile: ConnectedServiceQuotaProfileRefInput,
): NormalizedConnectedServiceQuotaProfileRef | null {
    if ('ref' in profile) {
        const ref = QualifiedConnectedAccountRefSchema.safeParse(profile.ref);
        if (!ref.success) return null;
        return {
            kind: 'qualified',
            key: connectedServiceProfileKey({
                serviceId: buildQualifiedPluginContributionKey(ref.data.service),
                profileId: ref.data.accountId,
            }),
            ref: ref.data,
        };
    }
    const parsedServiceId = ConnectedServiceIdSchema.safeParse(String(profile.serviceId ?? '').trim());
    const profileId = String(profile.profileId ?? '').trim();
    if (!parsedServiceId.success || !profileId) return null;
    return {
        kind: 'legacy',
        key: connectedServiceProfileKey({ serviceId: parsedServiceId.data, profileId }),
        serviceId: parsedServiceId.data,
        profileId,
    };
}

/**
 * The ONE profile-ref normalizer for quota consumers: trim, validate the
 * service id, drop unusable refs, dedupe by key, and order by key.
 *
 * The stable ordering is what makes the result safe to re-feed into another
 * quota hook and safe to fingerprint for memo/subscription identity, so callers
 * never need a second normalize pass of their own.
 */
export function normalizeConnectedServiceQuotaProfileRefs(
    profiles: ReadonlyArray<ConnectedServiceQuotaProfileRefInput>,
): NormalizedConnectedServiceQuotaProfileRef[] {
    const entries: NormalizedConnectedServiceQuotaProfileRef[] = [];
    const seenKeys = new Set<string>();
    for (const profile of profiles) {
        const normalized = normalizeConnectedServiceQuotaProfileRef(profile);
        if (!normalized || seenKeys.has(normalized.key)) continue;
        seenKeys.add(normalized.key);
        entries.push(normalized);
    }
    return entries.sort((a, b) => a.key.localeCompare(b.key));
}
