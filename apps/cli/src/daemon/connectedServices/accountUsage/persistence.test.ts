import {
    buildProviderAccountUsageRecordId,
    openProviderAccountUsageSnapshotCiphertext,
    openSealedProviderAccountUsageSnapshot,
    SealedProviderAccountUsageSnapshotV1Schema,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { StoredCredentials } from '@/persistence';

import {
    createProviderAccountUsagePersistenceScheduler,
    type QualifiedProviderAccountUsagePersistenceTarget,
} from './persistence';

type WriteQualifiedProviderAccountUsage = NonNullable<
    Parameters<typeof createProviderAccountUsagePersistenceScheduler>[0]['writeQualifiedProviderAccountUsage']
>;

function createSnapshot(
    overrides: Partial<ProviderAccountUsageSnapshotV1> = {},
): ProviderAccountUsageSnapshotV1 {
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

function createTarget(
    overrides: Partial<QualifiedProviderAccountUsagePersistenceTarget> = {},
): QualifiedProviderAccountUsagePersistenceTarget {
    return {
        source: {
            ref: {
                service: {
                    pluginId: 'happier.agent.codex',
                    localId: 'openai-codex',
                },
                accountId: 'work',
            },
            bindingKind: 'account',
        },
        expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        expectedConfigurationRevision: 'cfg-current',
        ...overrides,
    };
}

const plainCredentials = {
    token: 'token',
    encryption: null,
} satisfies StoredCredentials;

describe('provider account usage persistence scheduler', () => {
    it('publishes subscription freshness separately from unchanged quota history material', async () => {
        const writeQualifiedProviderAccountUsage = vi.fn<WriteQualifiedProviderAccountUsage>(async () => ({ success: true as const, source: { status: 'linked' as const } }));
        const scheduler = createProviderAccountUsagePersistenceScheduler({ api: { getAccountEncryptionMode: async () => 'plain' }, credentials: plainCredentials, writeQualifiedProviderAccountUsage, now: () => 1_500, fingerprintKey: new Uint8Array(32).fill(3), minFreshnessMs: 60_000 });
        const previous = createSnapshot({ subscription: { status: 'subscribed', renewal: 'on', observedAtMs: 900, staleAfterMs: 60_000 } });
        const refreshed = createSnapshot({ subscription: { ...previous.subscription!, observedAtMs: 950 } });
        const targets = [createTarget()];
        try {
            await scheduler.recordInBandSnapshot(previous, { targets });
            await scheduler.flush(1_000);
            expect(await scheduler.recordInBandSnapshot(refreshed, { targets })).toMatchObject({ status: 'enqueued' });
            await scheduler.flush(1_000);
            const first = writeQualifiedProviderAccountUsage.mock.calls[0]![0].write;
            const latest = writeQualifiedProviderAccountUsage.mock.calls[1]![0].write;
            expect(latest).toMatchObject({ fetchedAt: 1_000, snapshot: { subscription: { observedAtMs: 950 } }, metadata: { materialFingerprint: first.metadata?.materialFingerprint } });
            expect(await scheduler.recordInBandSnapshot(previous, { targets })).toMatchObject({ status: 'already_persisted', reason: 'unchanged_fresh' });
        } finally { scheduler.dispose(); }
    });

    it('writes a caller-proven qualified source and basis through the V4 PAU owner', async () => {
        const writeQualifiedProviderAccountUsage = vi.fn<WriteQualifiedProviderAccountUsage>(async () => ({
            success: true as const,
            source: { status: 'linked' as const },
        }));
        const snapshot = createSnapshot();
        const target = createTarget();
        const scheduler = createProviderAccountUsagePersistenceScheduler({
            api: {
                getAccountEncryptionMode: async () => 'plain',
            },
            credentials: plainCredentials,
            writeQualifiedProviderAccountUsage,
            now: () => 1_500,
            fingerprintKey: new Uint8Array(32).fill(3),
            minFreshnessMs: 60_000,
        });

        try {
            await expect(scheduler.recordInBandSnapshot(snapshot, {
                targets: [target],
            })).resolves.toEqual({
                status: 'enqueued',
                enqueue: 'accepted',
            });
            await scheduler.flush(1_000);
            expect(writeQualifiedProviderAccountUsage).toHaveBeenCalledWith({
                token: 'token',
                write: expect.objectContaining({
                    source: target.source,
                    expectedCredentialRevision: target.expectedCredentialRevision,
                    expectedConfigurationRevision: target.expectedConfigurationRevision,
                    recordId: snapshot.recordId,
                    recordKey: snapshot.recordKey,
                    payloadMode: 'plain_json_v1',
                    snapshot,
                    fetchedAt: snapshot.fetchedAtMs,
                    staleAfterMs: snapshot.staleAfterMs,
                    metadata: {
                        materialFingerprint: expect.any(String),
                    },
                }),
            });
            await expect(scheduler.recordInBandSnapshot(snapshot, {
                targets: [target],
            })).resolves.toEqual({
                status: 'already_persisted',
                reason: 'unchanged_fresh',
            });
        } finally {
            scheduler.dispose();
        }
    });

    it('treats a changed qualified currentness basis as a new durable relation', async () => {
        const writeQualifiedProviderAccountUsage = vi.fn<WriteQualifiedProviderAccountUsage>(async () => ({
            success: true as const,
            source: { status: 'linked' as const },
        }));
        const snapshot = createSnapshot();
        const first = createTarget();
        const second = createTarget({
            expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRT',
            expectedConfigurationRevision: 'cfg-next',
        });
        const scheduler = createProviderAccountUsagePersistenceScheduler({
            api: { getAccountEncryptionMode: async () => 'plain' },
            credentials: plainCredentials,
            writeQualifiedProviderAccountUsage,
            now: () => 1_500,
            fingerprintKey: new Uint8Array(32).fill(3),
            minFreshnessMs: 60_000,
        });

        try {
            await scheduler.recordInBandSnapshot(snapshot, { targets: [first] });
            await scheduler.flush(1_000);
            await expect(scheduler.recordInBandSnapshot(snapshot, {
                targets: [second],
            })).resolves.toEqual({
                status: 'enqueued',
                enqueue: 'accepted',
            });
            await scheduler.flush(1_000);
            expect(writeQualifiedProviderAccountUsage).toHaveBeenCalledTimes(2);
            expect(writeQualifiedProviderAccountUsage).toHaveBeenLastCalledWith({
                token: 'token',
                write: expect.objectContaining({
                    expectedCredentialRevision: second.expectedCredentialRevision,
                    expectedConfigurationRevision: second.expectedConfigurationRevision,
                }),
            });
        } finally {
            scheduler.dispose();
        }
    });

    it('uses the qualified V4 sealed envelope without a legacy quota shadow write', async () => {
        const encryption = {
            type: 'dataKey' as const,
            publicKey: new Uint8Array(32).fill(7),
            machineKey: new Uint8Array(32).fill(5),
        };
        const credentials = {
            token: 'token',
            encryption,
        } satisfies StoredCredentials;
        const writeQualifiedProviderAccountUsage = vi.fn<WriteQualifiedProviderAccountUsage>(async () => ({
            success: true as const,
            source: { status: 'linked' as const },
        }));
        const snapshot = createSnapshot({
            subscription: {
                status: 'subscribed', renewal: 'off', observedAtMs: 900,
                staleAfterMs: 60_000, currentPeriodEndAtMs: 1_800_000_000_000,
            },
            recoveryCredits: {
                availableCount: 1,
                credits: [{
                    id: 'credit-1',
                    kind: 'rate_limit_reset',
                    status: 'available',
                }],
            },
        });
        const scheduler = createProviderAccountUsagePersistenceScheduler({
            api: { getAccountEncryptionMode: async () => 'e2ee' },
            credentials,
            writeQualifiedProviderAccountUsage,
            randomBytes: (length) => new Uint8Array(length).fill(6),
            now: () => 1_500,
            fingerprintKey: new Uint8Array(32).fill(4),
            minFreshnessMs: 60_000,
        });

        try {
            await scheduler.recordInBandSnapshot(snapshot, {
                targets: [createTarget({
                    source: {
                        ref: {
                            service: {
                                pluginId: 'happier.agent.codex',
                                localId: 'openai-codex',
                            },
                            accountId: 'work',
                        },
                        bindingKind: 'group_member',
                        groupId: 'team',
                        groupGeneration: 4,
                    },
                })],
            });
            await scheduler.flush(1_000);

            expect(writeQualifiedProviderAccountUsage).toHaveBeenCalledWith({
                token: 'token',
                write: expect.objectContaining({
                    payloadMode: 'sealed_account_scoped_v1',
                    sealedPayload: {
                        format: 'account_scoped_v1',
                        ciphertext: expect.any(String),
                        subscription: {
                            observedAtMs: 900,
                            ciphertext: expect.any(String),
                        },
                    },
                }),
            });
            const call = writeQualifiedProviderAccountUsage.mock.calls[0]?.[0];
            const write = call && typeof call === 'object' && 'write' in call
                ? call.write
                : null;
            const sealedPayload = write
                && typeof write === 'object'
                && 'sealedPayload' in write
                && write.sealedPayload
                && typeof write.sealedPayload === 'object'
                && 'ciphertext' in write.sealedPayload
                ? write.sealedPayload
                : null;
            expect(sealedPayload).not.toBeNull();
            if (!sealedPayload || typeof sealedPayload.ciphertext !== 'string') {
                throw new Error('Expected the V4 PAU write to carry sealed ciphertext');
            }
            expect(openProviderAccountUsageSnapshotCiphertext({
                material: encryption,
                ciphertext: sealedPayload.ciphertext,
            })?.value).toMatchObject({
                recoveryCredits: { availableCount: 1 },
            });
            expect(openSealedProviderAccountUsageSnapshot({
                material: encryption,
                sealed: SealedProviderAccountUsageSnapshotV1Schema.parse(sealedPayload),
            })?.subscription).toEqual(snapshot.subscription);
        } finally {
            scheduler.dispose();
        }
    });

    it('does not emit an unqualified provider-account usage record', async () => {
        const writeQualifiedProviderAccountUsage = vi.fn<WriteQualifiedProviderAccountUsage>(async () => ({
            success: true as const,
        }));
        const scheduler = createProviderAccountUsagePersistenceScheduler({
            api: { getAccountEncryptionMode: async () => 'plain' },
            credentials: plainCredentials,
            writeQualifiedProviderAccountUsage,
            now: () => 1_500,
            fingerprintKey: new Uint8Array(32).fill(3),
        });

        try {
            await expect(scheduler.recordInBandSnapshot(createSnapshot())).resolves.toEqual({
                status: 'not_persisted',
                reason: 'no_current_qualified_source',
            });
            expect(writeQualifiedProviderAccountUsage).not.toHaveBeenCalled();
        } finally {
            scheduler.dispose();
        }
    });

    it('does not let a future-dated observation suppress a later current persistence write', async () => {
        const writeQualifiedProviderAccountUsage = vi.fn<WriteQualifiedProviderAccountUsage>(async () => ({
            success: true as const,
            source: { status: 'linked' as const },
        }));
        const scheduler = createProviderAccountUsagePersistenceScheduler({
            api: { getAccountEncryptionMode: async () => 'plain' },
            credentials: plainCredentials,
            writeQualifiedProviderAccountUsage,
            now: () => 10_000,
            fingerprintKey: new Uint8Array(32).fill(9),
            minFreshnessMs: 60_000,
        });
        const future = createSnapshot({ fetchedAtMs: 100_000, observedAtMs: 100_000 });
        const current = createSnapshot({ fetchedAtMs: 10_000, observedAtMs: 10_000 });
        try {
            await expect(scheduler.recordInBandSnapshot(future, {
                targets: [createTarget()],
            })).resolves.toEqual({
                status: 'already_persisted',
                reason: 'future_snapshot',
            });
            await expect(scheduler.recordInBandSnapshot(current, {
                targets: [createTarget()],
            })).resolves.toEqual({
                status: 'enqueued',
                enqueue: 'accepted',
            });
            await scheduler.flush(1_000);
            expect(writeQualifiedProviderAccountUsage).toHaveBeenCalledTimes(1);
            expect(writeQualifiedProviderAccountUsage).toHaveBeenCalledWith(expect.objectContaining({
                write: expect.objectContaining({ fetchedAt: 10_000 }),
            }));
        } finally {
            scheduler.dispose();
        }
    });
});
