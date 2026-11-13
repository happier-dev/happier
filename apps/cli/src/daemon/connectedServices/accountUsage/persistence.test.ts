import {
    buildProviderAccountUsageRecordId,
    openProviderAccountUsageSnapshotCiphertext,
    openSealedProviderAccountUsageSnapshot,
    SealedProviderAccountUsageSnapshotV1Schema,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import type { StoredCredentials } from '@/persistence';
import { QualifiedProviderAccountUsageWriteV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';

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

// These incumbent writer fixtures model a server without the additive summary
// operation. Tests exercising that operation install its response explicitly.
beforeEach(() => { vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: {} }); });
afterEach(() => { vi.restoreAllMocks(); });

describe('provider account usage persistence scheduler', () => {
    it('persists every valid queued source beyond 500 records and ten minutes of delayed Home writes', async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const post = vi.spyOn(axios, 'post').mockImplementation(async () => {
            await held;
            return { status: 200, data: { success: true, source: { status: 'linked' } } };
        });
        let now = 1_500;
        const scheduler = createProviderAccountUsagePersistenceScheduler({
            api: { getAccountEncryptionMode: async () => 'plain' }, credentials: plainCredentials,
            now: () => now, fingerprintKey: new Uint8Array(32).fill(3),
        });
        const snapshot = createSnapshot({ staleAfterMs: 24 * 60 * 60_000 });
        try {
            for (let index = 0; index < 505; index += 1) {
                const original = createTarget();
                await scheduler.recordInBandSnapshot(snapshot, { targets: [createTarget({ source: {
                    ...original.source, ref: { ...original.source.ref, accountId: `account-${index}` },
                } })] });
            }
            now += 11 * 60_000;
            release();
            await scheduler.flush(5_000);
            expect(post).toHaveBeenCalledTimes(505);
            const accounts = new Set(post.mock.calls.map((call) => QualifiedProviderAccountUsageWriteV4Schema.parse(call[1]).source.ref.accountId));
            expect(accounts.size).toBe(505);
        } finally { release(); scheduler.dispose(); post.mockRestore(); }
    });

    it.each(['plain', 'e2ee'] as const)('rereads %s current content after conflict exhaustion instead of blindly rewriting it', async mode => {
        const snapshot = createSnapshot();
        const target = createTarget();
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const { sealProviderAccountUsageSnapshot } = await import('@happier-dev/protocol/connect/accountUsage');
        const sealed = sealProviderAccountUsageSnapshot({ snapshot, material, randomBytes: length => new Uint8Array(length).fill(9) });
        const post = vi.spyOn(axios, 'post').mockRejectedValue({ response: { status: 503, data: { error: 'database_transaction_conflict_exhausted' } } });
        const get = vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: String(url).includes('/day-summaries') ? 404 : 200, data: {
            content: mode === 'plain' ? { t: 'plain', v: snapshot } : { t: 'encrypted', c: sealed.ciphertext },
            metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status: 'ok' }, sources: [target.source],
        } }));
        const scheduler = createProviderAccountUsagePersistenceScheduler({
            api: { getAccountEncryptionMode: async () => mode },
            credentials: mode === 'plain' ? plainCredentials : { token: 'token', encryption: material },
            now: () => 1_500, randomBytes: length => new Uint8Array(length).fill(9),
        });
        try {
            await scheduler.recordInBandSnapshot(snapshot, { targets: [target] });
            await scheduler.flush(1_000);
            expect(get.mock.calls.filter(call => String(call[0]).includes('/provider-account-usage/record?'))).toHaveLength(1);
            expect(get.mock.calls[0]?.[0]).toContain('/provider-account-usage/record?');
            expect(post).toHaveBeenCalledTimes(1);
            expect(post.mock.calls[0]?.[1]).not.toHaveProperty('material');
            expect(await scheduler.recordInBandSnapshot(snapshot, { targets: [target] })).toMatchObject({ status: 'already_persisted' });
        } finally { scheduler.dispose(); post.mockRestore(); get.mockRestore(); }
    });

    it('coalesces unchanged observations arriving during a write and still publishes changed material', async () => {
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const post = vi.spyOn(axios, 'post').mockImplementation(async () => {
            await held;
            return { status: 200, data: { success: true, source: { status: 'linked' } } };
        });
        const scheduler = createProviderAccountUsagePersistenceScheduler({
            api: { getAccountEncryptionMode: async () => 'plain' }, credentials: plainCredentials,
            now: () => 1_500, fingerprintKey: new Uint8Array(32).fill(3),
        });
        const snapshot = createSnapshot();
        const targets = [createTarget()];
        try {
            await scheduler.recordInBandSnapshot(snapshot, { targets });
            await expect.poll(() => post.mock.calls.length).toBe(1);
            for (let index = 0; index < 10; index++) await scheduler.recordInBandSnapshot(snapshot, { targets });
            release();
            await scheduler.flush(1_000);
            expect(post).toHaveBeenCalledTimes(1);
            await scheduler.recordInBandSnapshot({ ...snapshot, planLabel: 'changed' }, { targets });
            await scheduler.flush(1_000);
            expect(post).toHaveBeenCalledTimes(2);
            expect(post.mock.calls[1]?.[1]).toMatchObject({ snapshot: { planLabel: 'changed' } });
        } finally { release(); scheduler.dispose(); post.mockRestore(); }
    });

    it.each(['plain', 'e2ee'] as const)('publishes recovery-detail updates through the real V4 writer for %s accounts', async (mode) => {
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { success: true, source: { status: 'linked' } } });
        const encryption = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const scheduler = createProviderAccountUsagePersistenceScheduler({
            api: { getAccountEncryptionMode: async () => mode },
            credentials: mode === 'plain' ? plainCredentials : { token: 'token', encryption },
            now: () => 1_500, fingerprintKey: new Uint8Array(32).fill(3),
            randomBytes: (length) => new Uint8Array(length).fill(6), minFreshnessMs: 60_000,
        });
        const initial = createSnapshot({ recoveryCreditDetails: { grant: { remainingCount: 2, appliesToProviderLimitIds: ['weekly'] } } });
        const changed = createSnapshot({ recoveryCreditDetails: { grant: { remainingCount: 1, appliesToProviderLimitIds: ['weekly'], unavailableReason: 'cooldown' } } });
        try {
            await scheduler.recordInBandSnapshot(initial, { targets: [createTarget()] });
            await scheduler.flush(1_000);
            expect(await scheduler.recordInBandSnapshot(changed, { targets: [createTarget()] })).toMatchObject({ status: 'enqueued' });
            await scheduler.flush(1_000);
            const write = post.mock.calls.at(-1)?.[1];
            expect(post.mock.calls.at(-1)?.[0]).toContain('/v4/connect/qualified/provider-account-usage');
            if (mode === 'plain') {
                expect(write).toMatchObject({ snapshot: { recoveryCreditDetails: changed.recoveryCreditDetails } });
            } else {
                const sealed = SealedProviderAccountUsageSnapshotV1Schema.parse(QualifiedProviderAccountUsageWriteV4Schema.parse(write).sealedPayload);
                expect(openSealedProviderAccountUsageSnapshot({ material: encryption, sealed })?.recoveryCreditDetails).toEqual(changed.recoveryCreditDetails);
                expect(write).not.toHaveProperty('snapshot');
            }
        } finally {
            scheduler.dispose();
            post.mockRestore();
        }
    });

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
            const first = QualifiedProviderAccountUsageWriteV4Schema.parse(writeQualifiedProviderAccountUsage.mock.calls[0]![0].write);
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
                material: credentials.encryption,
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
