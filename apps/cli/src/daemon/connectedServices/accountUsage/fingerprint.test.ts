import {
    buildProviderAccountUsageRecordId,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

type FingerprintModule = Readonly<{
    computeProviderAccountUsageSnapshotFingerprint(
        snapshot: ProviderAccountUsageSnapshotV1,
        key: Uint8Array,
    ): string;
}>;

async function loadFingerprintModule(): Promise<FingerprintModule | null> {
    return await import('./fingerprint').catch(() => null) as FingerprintModule | null;
}

const recordKey: ProviderAccountUsageRecordKeyV1 = {
    providerId: 'codex',
    accountSubjectId: 'acct_123',
    subjectKind: 'account',
    quotaScope: 'account',
};

function createSnapshot(overrides: Partial<ProviderAccountUsageSnapshotV1> = {}): ProviderAccountUsageSnapshotV1 {
    return {
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: 'codex',
        accountSubject: { kind: 'providerSubject', id: 'acct_123' },
        observedAtMs: 1_000,
        fetchedAtMs: 1_000,
        staleAfterMs: 300_000,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        planLabel: 'Pro',
        accountLabel: 'acct label',
        meters: [{
            meterId: 'weekly',
            label: 'Weekly',
            used: null,
            limit: null,
            remainingPct: 42,
            unit: 'requests',
            utilizationPct: null,
            resetsAt: 9_000,
            status: 'ok',
            resetAtMs: 9_000,
            details: {},
        }],
        diagnostics: [{ kind: 'runtime_signal', code: 'loaded', message: 'Loaded at runtime' }],
        ...overrides,
    };
}

describe('provider account usage material fingerprint', () => {
    it('ignores refresh timestamps and diagnostics while detecting material meter changes', async () => {
        const module = await loadFingerprintModule();
        expect(module).not.toBeNull();
        const key = new Uint8Array(32).fill(7);
        const first = createSnapshot();
        const sameMaterial = createSnapshot({
            observedAtMs: 2_000,
            fetchedAtMs: 2_000,
            diagnostics: [{ kind: 'runtime_signal', code: 'refreshed', message: 'Refreshed later' }],
        });
        const changedMeter = createSnapshot({
            meters: [{
                meterId: 'weekly',
                label: 'Weekly',
                used: null,
                limit: null,
                remainingPct: 7,
                unit: 'requests',
                utilizationPct: null,
                resetsAt: 9_000,
                status: 'ok',
                resetAtMs: 9_000,
                details: {},
            }],
        });

        expect(module!.computeProviderAccountUsageSnapshotFingerprint(first, key)).toBe(
            module!.computeProviderAccountUsageSnapshotFingerprint(sameMaterial, key),
        );
        expect(module!.computeProviderAccountUsageSnapshotFingerprint(first, key)).not.toBe(
            module!.computeProviderAccountUsageSnapshotFingerprint(changedMeter, key),
        );
    });
});
