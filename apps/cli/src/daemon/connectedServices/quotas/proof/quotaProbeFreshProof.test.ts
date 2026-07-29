import { describe, expect, it } from 'vitest';

import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import { resolveQuotaProbeFreshProof } from './quotaProbeFreshProof';

function quotaSnapshot(overrides: Partial<ConnectedServiceQuotaSnapshotV1> = {}): ConnectedServiceQuotaSnapshotV1 {
    return {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'backup',
        fetchedAt: 10_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [{
            meterId: 'weekly',
            label: 'Weekly',
            used: 10,
            limit: 100,
            unit: 'requests',
            utilizationPct: 10,
            remainingPct: 90,
            resetsAt: 100_000,
            status: 'ok',
            details: {},
        }],
        ...overrides,
    };
}

describe('resolveQuotaProbeFreshProof', () => {
    const appliedIdentity = {
        serviceId: 'openai-codex' as const,
        profileId: 'backup',
        groupId: 'team',
        groupGeneration: 3,
        providerAccountId: 'acct-provider-a',
        materialFingerprint: 'fingerprint-a',
    };

    it('produces quota_probe_fresh only for fresh matching usable normalized quota evidence', () => {
        expect(resolveQuotaProbeFreshProof({
            nowMs: 12_000,
            maxAgeMs: 30_000,
            serviceId: 'openai-codex',
            profileId: 'backup',
            expectedAppliedIdentity: appliedIdentity,
            snapshotAppliedIdentity: appliedIdentity,
            snapshot: quotaSnapshot(),
        })).toEqual({
            status: 'proof',
            proofKind: 'quota_probe_fresh',
        });
    });

    it.each([
        { name: 'both tuples missing', expectedAppliedIdentity: null, snapshotAppliedIdentity: null },
        { name: 'expected tuple missing', expectedAppliedIdentity: null, snapshotAppliedIdentity: appliedIdentity },
        { name: 'snapshot tuple missing', expectedAppliedIdentity: appliedIdentity, snapshotAppliedIdentity: null },
        {
            name: 'distinct fractional generations collapse to the same integer',
            expectedAppliedIdentity: { ...appliedIdentity, groupGeneration: 3.9 },
            snapshotAppliedIdentity: { ...appliedIdentity, groupGeneration: 3.1 },
        },
        { name: 'both provider account ids missing', expectedAppliedIdentity: { ...appliedIdentity, providerAccountId: null }, snapshotAppliedIdentity: { ...appliedIdentity, providerAccountId: null } },
        { name: 'expected provider account id missing', expectedAppliedIdentity: { ...appliedIdentity, providerAccountId: null }, snapshotAppliedIdentity: appliedIdentity },
        { name: 'snapshot provider account id missing', expectedAppliedIdentity: appliedIdentity, snapshotAppliedIdentity: { ...appliedIdentity, providerAccountId: null } },
        { name: 'both material fingerprints missing despite fresh host time and a matching group', expectedAppliedIdentity: { ...appliedIdentity, materialFingerprint: null }, snapshotAppliedIdentity: { ...appliedIdentity, materialFingerprint: null } },
        { name: 'expected material fingerprint missing', expectedAppliedIdentity: { ...appliedIdentity, materialFingerprint: null }, snapshotAppliedIdentity: appliedIdentity },
        { name: 'snapshot material fingerprint missing', expectedAppliedIdentity: appliedIdentity, snapshotAppliedIdentity: { ...appliedIdentity, materialFingerprint: null } },
    ])('refuses provider proof when $name', ({ expectedAppliedIdentity, snapshotAppliedIdentity }) => {
        expect(resolveQuotaProbeFreshProof({
            nowMs: 12_000,
            maxAgeMs: 30_000,
            serviceId: 'openai-codex',
            profileId: 'backup',
            expectedAppliedIdentity,
            snapshotAppliedIdentity,
            snapshot: quotaSnapshot(),
        })).toEqual({ status: 'no_proof', reason: 'provider_operation_identity_missing' });
    });

    it.each([
        ['service', { serviceId: 'anthropic' as const }],
        ['profile', { profileId: 'other' }],
        ['group', { groupId: 'other-team' }],
        ['generation', { groupGeneration: 4 }],
        ['provider account', { providerAccountId: 'acct-provider-b' }],
        ['material fingerprint', { materialFingerprint: 'fingerprint-b' }],
    ])('refuses a provider-operation tuple with mismatched %s', (_field, override) => {
        expect(resolveQuotaProbeFreshProof({
            nowMs: 12_000,
            maxAgeMs: 30_000,
            serviceId: 'openai-codex',
            profileId: 'backup',
            expectedAppliedIdentity: appliedIdentity,
            snapshotAppliedIdentity: { ...appliedIdentity, ...override },
            snapshot: quotaSnapshot(),
        })).toEqual({ status: 'no_proof', reason: 'provider_operation_identity_mismatch' });
    });

    it('refuses stale, exhausted, disabled, mismatched, and generation-stale snapshots', () => {
        const base = {
            nowMs: 12_000,
            maxAgeMs: 1_000,
            serviceId: 'openai-codex' as const,
            profileId: 'backup',
            expectedAppliedIdentity: appliedIdentity,
            snapshotAppliedIdentity: appliedIdentity,
            snapshot: quotaSnapshot(),
        };

        expect(resolveQuotaProbeFreshProof(base)).toEqual({ status: 'no_proof', reason: 'stale_snapshot' });
        expect(resolveQuotaProbeFreshProof({
            ...base,
            nowMs: 12_000,
            maxAgeMs: 30_000,
            snapshot: quotaSnapshot({ fetchedAt: 12_001 }),
        })).toEqual({ status: 'no_proof', reason: 'stale_snapshot' });
        expect(resolveQuotaProbeFreshProof({
            ...base,
            nowMs: 12_000,
            maxAgeMs: 30_000,
            snapshot: quotaSnapshot({ staleAfterMs: 1_000 }),
        })).toEqual({ status: 'no_proof', reason: 'stale_snapshot' });
        expect(resolveQuotaProbeFreshProof({
            ...base,
            nowMs: 12_000,
            maxAgeMs: 30_000,
            snapshot: quotaSnapshot({
                meters: [{
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 100,
                    limit: 100,
                    unit: 'requests',
                    utilizationPct: 100,
                    remainingPct: 0,
                    resetsAt: 100_000,
                    status: 'ok',
                    details: {},
                }],
            }),
        })).toEqual({ status: 'no_proof', reason: 'snapshot_exhausted' });
        expect(resolveQuotaProbeFreshProof({
            ...base,
            nowMs: 12_000,
            maxAgeMs: 30_000,
            snapshot: quotaSnapshot({
                meters: [{
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: null,
                    limit: null,
                    unit: 'unknown',
                    utilizationPct: null,
                    remainingPct: null,
                    resetsAt: null,
                    status: 'unavailable',
                    confidence: 'unknown',
                    details: { code: 'quota_fetch_disabled' },
                }],
            }),
        })).toEqual({ status: 'no_proof', reason: 'snapshot_unavailable' });
        expect(resolveQuotaProbeFreshProof({
            ...base,
            nowMs: 12_000,
            maxAgeMs: 30_000,
            profileId: 'other',
        })).toEqual({ status: 'no_proof', reason: 'profile_mismatch' });
        expect(resolveQuotaProbeFreshProof({
            ...base,
            nowMs: 12_000,
            maxAgeMs: 30_000,
            snapshotAppliedIdentity: { ...appliedIdentity, groupGeneration: 4 },
        })).toEqual({ status: 'no_proof', reason: 'provider_operation_identity_mismatch' });
        expect(resolveQuotaProbeFreshProof({
            ...base,
            nowMs: 12_000,
            maxAgeMs: 30_000,
            snapshotAppliedIdentity: { ...appliedIdentity, materialFingerprint: 'fingerprint-b' },
        })).toEqual({ status: 'no_proof', reason: 'provider_operation_identity_mismatch' });
    });
});
