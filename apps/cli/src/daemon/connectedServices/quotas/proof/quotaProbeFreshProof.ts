import type {
    ConnectedServiceId,
    ConnectedServiceQuotaMeterV1,
    ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';
import { readConnectedServiceLimitCategoryV1 } from '@happier-dev/protocol';

import { normalizeQuotaMeter, selectEffectiveQuotaMeter } from '../normalization';
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

function isUnavailableMeter(meter: ConnectedServiceQuotaMeterV1): boolean {
    return meter.status === 'unavailable'
        || meter.confidence === 'unknown'
        || meter.confidence === 'stale';
}

function normalizeMeter(meter: ConnectedServiceQuotaMeterV1) {
    return normalizeQuotaMeter({
        meterId: meter.meterId,
        label: meter.label,
        limitCategory: readConnectedServiceLimitCategoryV1(
            typeof meter.details === 'object' && meter.details !== null && !Array.isArray(meter.details)
                ? meter.details.limitCategory
                : undefined,
        ) ?? 'usage_limit',
        remainingPct: meter.remainingPct,
        utilizationPct: meter.utilizationPct,
        used: meter.used,
        limit: meter.limit,
        resetAtMs: meter.resetAtMs ?? meter.resetsAt,
        providerLimitId: meter.providerLimitId,
        reliable: !isUnavailableMeter(meter),
        applicable: meter.status !== 'unavailable',
    });
}

export function resolveQuotaProbeFreshProof(input: Readonly<{
    nowMs: number;
    maxAgeMs: number;
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
    const configuredMaxAgeMs = Math.max(1, Math.trunc(input.maxAgeMs));
    const snapshotMaxAgeMs = Number.isFinite(input.snapshot.staleAfterMs)
        ? Math.max(1, Math.trunc(input.snapshot.staleAfterMs))
        : configuredMaxAgeMs;
    const maxAgeMs = Math.min(configuredMaxAgeMs, snapshotMaxAgeMs);
    const nowMs = Math.max(0, Math.trunc(input.nowMs));
    if (fetchedAt > nowMs || nowMs - fetchedAt > maxAgeMs) {
        return { status: 'no_proof', reason: 'stale_snapshot' };
    }
    if (input.snapshot.meters.length > 0 && input.snapshot.meters.every(isUnavailableMeter)) {
        return { status: 'no_proof', reason: 'snapshot_unavailable' };
    }
    const effective = selectEffectiveQuotaMeter(input.snapshot.meters.map(normalizeMeter));
    if (!effective) return { status: 'no_proof', reason: 'no_reliable_quota_meter' };
    if (effective.remainingPct !== null && effective.remainingPct <= 0) {
        return { status: 'no_proof', reason: 'snapshot_exhausted' };
    }
    return { status: 'proof', proofKind: 'quota_probe_fresh' };
}
