import type {
    ConnectedServiceId,
    ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';
import { isConnectedServiceQuotaObservationFresh } from '@happier-dev/protocol/connect/quotaObservationTime';
import { normalizeConnectedServiceAuthGroupQuotaMeter } from '../../accountGroups/quotas/projection';
import { selectEffectiveQuotaMeter } from '../normalization';
import type { ProviderOutcomeProofKind } from '../../recovery/providerOutcomeProof';

export type QuotaProbeFreshNoProofReason =
    | 'service_mismatch'
    | 'profile_mismatch'
    | 'provider_operation_identity_missing'
    | 'provider_operation_identity_mismatch'
    | 'stale_snapshot'
    | 'snapshot_unavailable'
    | 'snapshot_exhausted'
    | 'no_reliable_quota_meter';

export type QuotaProbeFreshProofResult =
    | Readonly<{ status: 'proof'; proofKind: Extract<ProviderOutcomeProofKind, 'quota_probe_fresh'> }>
    | Readonly<{ status: 'no_proof'; reason: QuotaProbeFreshNoProofReason }>;

function normalizeRequiredString(value: string | null | undefined): string | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed ? trimmed : null;
}

function normalizeGeneration(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : null;
}

export type QuotaProbeAppliedIdentity = Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    groupId: string | null;
    groupGeneration: number | null;
    providerAccountId: string | null;
    materialFingerprint: string | null;
}>;

type NormalizedQuotaProbeAppliedIdentity = Omit<QuotaProbeAppliedIdentity, 'providerAccountId' | 'materialFingerprint'> & Readonly<{
    providerAccountId: string;
    materialFingerprint: string;
}>;

function normalizeAppliedIdentity(identity: QuotaProbeAppliedIdentity | null): NormalizedQuotaProbeAppliedIdentity | null {
    if (!identity) return null;
    const profileId = normalizeRequiredString(identity.profileId);
    const groupId = normalizeRequiredString(identity.groupId);
    const providerAccountId = normalizeRequiredString(identity.providerAccountId);
    const materialFingerprint = normalizeRequiredString(identity.materialFingerprint);
    const groupGeneration = normalizeGeneration(identity.groupGeneration);
    if (!profileId || !providerAccountId || !materialFingerprint) return null;
    if ((groupId === null) !== (groupGeneration === null)) return null;
    return {
        serviceId: identity.serviceId,
        profileId,
        groupId,
        groupGeneration,
        providerAccountId,
        materialFingerprint,
    };
}

function appliedIdentitiesMatch(
    expected: NormalizedQuotaProbeAppliedIdentity,
    observed: NormalizedQuotaProbeAppliedIdentity,
): boolean {
    return expected.serviceId === observed.serviceId
        && expected.profileId === observed.profileId
        && expected.groupId === observed.groupId
        && expected.groupGeneration === observed.groupGeneration
        && expected.providerAccountId === observed.providerAccountId
        && expected.materialFingerprint === observed.materialFingerprint;
}

export function resolveQuotaProbeFreshProof(input: Readonly<{
    nowMs: number;
    serviceId: ConnectedServiceId;
    profileId: string;
    expectedAppliedIdentity: QuotaProbeAppliedIdentity | null;
    snapshotAppliedIdentity: QuotaProbeAppliedIdentity | null;
    snapshot: ConnectedServiceQuotaSnapshotV1;
}>): QuotaProbeFreshProofResult {
    if (input.snapshot.serviceId !== input.serviceId) {
        return { status: 'no_proof', reason: 'service_mismatch' };
    }
    if (input.snapshot.profileId !== input.profileId) {
        return { status: 'no_proof', reason: 'profile_mismatch' };
    }
    const expectedIdentity = normalizeAppliedIdentity(input.expectedAppliedIdentity);
    const snapshotIdentity = normalizeAppliedIdentity(input.snapshotAppliedIdentity);
    if (!expectedIdentity || !snapshotIdentity) {
        return { status: 'no_proof', reason: 'provider_operation_identity_missing' };
    }
    if (
        expectedIdentity.serviceId !== input.serviceId
        || expectedIdentity.profileId !== input.profileId
        || !appliedIdentitiesMatch(expectedIdentity, snapshotIdentity)
    ) {
        return { status: 'no_proof', reason: 'provider_operation_identity_mismatch' };
    }
    const fetchedAt = Number.isFinite(input.snapshot.fetchedAt) ? Math.trunc(input.snapshot.fetchedAt) : 0;
    const nowMs = Math.max(0, Math.trunc(input.nowMs));
    if (!isConnectedServiceQuotaObservationFresh({ observedAtMs: fetchedAt, nowMs, maxAgeMs: input.snapshot.staleAfterMs })) {
        return { status: 'no_proof', reason: 'stale_snapshot' };
    }
    const meters = input.snapshot.meters.map(normalizeConnectedServiceAuthGroupQuotaMeter);
    if (meters.length > 0 && meters.every((meter) => !meter.applicable)) {
        return { status: 'no_proof', reason: 'snapshot_unavailable' };
    }
    const effective = selectEffectiveQuotaMeter(meters);
    if (!effective) return { status: 'no_proof', reason: 'no_reliable_quota_meter' };
    if (effective.remainingPct !== null && effective.remainingPct <= 0) {
        return { status: 'no_proof', reason: 'snapshot_exhausted' };
    }
    return { status: 'proof', proofKind: 'quota_probe_fresh' };
}

/** Exact profile-local token proof; global usage subject qualification remains separate. */
export function matchesCurrentQuotaObservationCredential(input: Readonly<{
    credential: Readonly<{ providerAccountId: string | null; providerOrganizationId?: string | null; credentialFingerprint: string | null }> | null;
    providerAccountId: string;
    providerOrganizationId?: string | null;
    credentialFingerprint: string;
}>): boolean {
    const accountId = normalizeRequiredString(input.providerAccountId);
    const fingerprint = normalizeRequiredString(input.credentialFingerprint);
    const organizationId = normalizeRequiredString(input.providerOrganizationId);
    return input.credential !== null && accountId !== null && fingerprint !== null
        && normalizeRequiredString(input.credential.providerAccountId) === accountId
        && (organizationId === null || normalizeRequiredString(input.credential.providerOrganizationId) === organizationId)
        && normalizeRequiredString(input.credential.credentialFingerprint) === fingerprint;
}
