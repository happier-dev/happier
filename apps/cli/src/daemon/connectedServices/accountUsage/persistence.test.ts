import {
    buildProviderAccountUsageRecordId,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

type PersistenceScheduler = Readonly<{
    recordInBandSnapshot(snapshot: ProviderAccountUsageSnapshotV1): Promise<
        | Readonly<{ status: 'enqueued'; enqueue: 'accepted' | 'coalesced' }>
        | Readonly<{ status: 'suppressed'; reason: string }>
    >;
    flush(timeoutMs: number): Promise<void>;
    dispose(): void;
}>;

type PersistenceModule = Readonly<{
    createProviderAccountUsagePersistenceScheduler(params: Readonly<{
        api: {
            getAccountEncryptionMode: () => Promise<'plain' | 'e2ee' | 'unknown'>;
            registerProviderAccountUsageSnapshotPlain?: (args: Readonly<{
                recordId: string;
                content: { t: 'plain'; v: ProviderAccountUsageSnapshotV1 };
                metadata: {
                    fetchedAt: number;
                    staleAfterMs: number;
                    status: 'ok' | 'unavailable' | 'estimated' | 'error';
                    materialFingerprint?: string;
                };
            }>) => Promise<void>;
            registerProviderAccountUsageSnapshotSealed?: (args: Readonly<{
                recordId: string;
                sealed: { format: 'account_scoped_v1'; ciphertext: string };
                metadata: {
                    fetchedAt: number;
                    staleAfterMs: number;
                    status: 'ok' | 'unavailable' | 'estimated' | 'error';
                    materialFingerprint?: string;
                };
            }>) => Promise<void>;
        };
        now: () => number;
        fingerprintKey: Uint8Array;
        credentials?: { token: string; encryption: { type: 'legacy'; secret: Uint8Array } };
        randomBytes?: (length: number) => Uint8Array;
        minFreshnessMs: number;
    }>): PersistenceScheduler;
}>;

async function loadPersistenceModule(): Promise<PersistenceModule | null> {
    return await import('./persistence').catch(() => null) as PersistenceModule | null;
}

function createSnapshot(overrides: Partial<ProviderAccountUsageSnapshotV1> = {}): ProviderAccountUsageSnapshotV1 {
    const recordKey: ProviderAccountUsageRecordKeyV1 = {
        providerId: 'codex',
        accountSubjectId: 'acct_123',
        subjectKind: 'account',
        quotaScope: 'account',
    };
    return {
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: 'codex',
        accountSubject: { kind: 'providerSubject', id: 'acct_123' },
        aliases: [{ kind: 'appServerNative', providerId: 'codex', accountSubjectId: 'acct_123' }],
        observedAtMs: 1_000,
        fetchedAtMs: 1_000,
        staleAfterMs: 300_000,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        meters: [],
        ...overrides,
    };
}

describe('provider account usage persistence scheduler', () => {
    it('persists the first plain snapshot and suppresses unchanged fresh repeats', async () => {
        const module = await loadPersistenceModule();
        expect(module).not.toBeNull();
        const registerProviderAccountUsageSnapshotPlain = vi.fn(async () => {});
        const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
            api: {
                getAccountEncryptionMode: async () => 'plain',
                registerProviderAccountUsageSnapshotPlain,
            },
            now: () => 1_500,
            fingerprintKey: new Uint8Array(32).fill(3),
            minFreshnessMs: 60_000,
        });

        try {
            const snapshot = createSnapshot();
            await expect(scheduler.recordInBandSnapshot(snapshot)).resolves.toEqual({
                status: 'enqueued',
                enqueue: 'accepted',
            });
            await scheduler.flush(1_000);
            expect(registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith({
                recordId: snapshot.recordId,
                content: { t: 'plain', v: snapshot },
                metadata: {
                    fetchedAt: 1_000,
                    staleAfterMs: 300_000,
                    status: 'ok',
                    materialFingerprint: expect.any(String),
                },
            });
            await expect(scheduler.recordInBandSnapshot(createSnapshot())).resolves.toEqual({
                status: 'suppressed',
                reason: 'unchanged_fresh',
            });
        } finally {
            scheduler.dispose();
        }
    });

    it('uses the sealed canonical route for e2ee account usage snapshots', async () => {
        const module = await loadPersistenceModule();
        expect(module).not.toBeNull();
        const registerProviderAccountUsageSnapshotSealed = vi.fn(async () => {});
        const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
            api: {
                getAccountEncryptionMode: async () => 'e2ee',
                registerProviderAccountUsageSnapshotSealed,
            },
            now: () => 1_500,
            fingerprintKey: new Uint8Array(32).fill(4),
            credentials: {
                token: 'token',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(5) },
            },
            randomBytes: (length) => new Uint8Array(length).fill(6),
            minFreshnessMs: 60_000,
        });

        try {
            const snapshot = createSnapshot();
            await expect(scheduler.recordInBandSnapshot(snapshot)).resolves.toEqual({
                status: 'enqueued',
                enqueue: 'accepted',
            });
            await scheduler.flush(1_000);
            expect(registerProviderAccountUsageSnapshotSealed).toHaveBeenCalledWith({
                recordId: snapshot.recordId,
                sealed: {
                    format: 'account_scoped_v1',
                    ciphertext: expect.any(String),
                },
                metadata: {
                    fetchedAt: 1_000,
                    staleAfterMs: 300_000,
                    status: 'ok',
                    materialFingerprint: expect.any(String),
                },
            });
        } finally {
            scheduler.dispose();
        }
    });
});
