import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeExternalSessionHistoricalImportBatchIdV1 } from '@happier-dev/protocol';

import { executeExternalSessionHistoricalImportCommand } from '@/app/session/externalSessionHistoricalImportCommand';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

describe('sessionSidechainMessageRetentionRule', () => {
    let harness: LightSqliteHarness;

    const old = new Date('2025-01-01T00:00:00.000Z');
    const recent = new Date('2027-01-01T00:00:00.000Z');
    const cutoff = new Date('2026-01-01T00:00:00.000Z');

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'retention-session-sidechain-message-rule-',
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        });
        await harness.resetDbTables([
            () => db.simpleCache.deleteMany(),
            () => db.sessionMessage.deleteMany(),
            () => db.sessionSystemRecord.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
        await db.account.create({ data: { id: 'owner' } });
    });

    async function createSession(id: string, seq: number) {
        await db.session.create({
            data: {
                id,
                tag: id,
                accountId: 'owner',
                metadata: '{}',
                active: true,
                lastActiveAt: recent,
                updatedAt: recent,
                seq,
            },
        });
    }

    async function createMessage(params: Readonly<{
        sessionId: string;
        seq: number;
        sidechainId: string | null;
        createdAt: Date;
    }>) {
        await db.sessionMessage.create({
            data: {
                ...params,
                content: { t: 'plain', v: { text: `${params.sessionId}:${params.seq}` } },
            },
        });
    }

    it('prunes only wholly expired sidechains while preserving main and recently active transcripts', async () => {
        await createSession('a-empty', 1);
        await createMessage({ sessionId: 'a-empty', seq: 1, sidechainId: null, createdAt: old });

        await createSession('z-target', 6);
        await createMessage({ sessionId: 'z-target', seq: 1, sidechainId: null, createdAt: old });
        await createMessage({ sessionId: 'z-target', seq: 2, sidechainId: 'expired', createdAt: old });
        await createMessage({ sessionId: 'z-target', seq: 3, sidechainId: 'expired', createdAt: old });
        await createMessage({ sessionId: 'z-target', seq: 4, sidechainId: 'mixed', createdAt: old });
        await createMessage({ sessionId: 'z-target', seq: 5, sidechainId: 'mixed', createdAt: recent });
        await createMessage({ sessionId: 'z-target', seq: 6, sidechainId: 'recent', createdAt: recent });

        const { runSessionSidechainMessageRetentionRule } = await import('./sessionSidechainMessageRetentionRule');
        const result = await runSessionSidechainMessageRetentionRule({
            cutoff,
            batchSize: 1,
            dryRun: false,
            maxDeletesPerRulePerRun: 10,
        });

        expect(result).toMatchObject({ deleted: 2 });
        await expect(db.sessionMessage.findMany({
            orderBy: [{ sessionId: 'asc' }, { seq: 'asc' }],
            select: { sessionId: true, seq: true, sidechainId: true },
        })).resolves.toEqual([
            { sessionId: 'a-empty', seq: 1, sidechainId: null },
            { sessionId: 'z-target', seq: 1, sidechainId: null },
            { sessionId: 'z-target', seq: 4, sidechainId: 'mixed' },
            { sessionId: 'z-target', seq: 5, sidechainId: 'mixed' },
            { sessionId: 'z-target', seq: 6, sidechainId: 'recent' },
        ]);
    });

    it('honors dry-run and the per-rule delete cap across short database batches', async () => {
        await createSession('target', 3);
        for (const seq of [1, 2, 3]) {
            await createMessage({ sessionId: 'target', seq, sidechainId: 'expired', createdAt: old });
        }

        const { runSessionSidechainMessageRetentionRule } = await import('./sessionSidechainMessageRetentionRule');
        await expect(runSessionSidechainMessageRetentionRule({
            cutoff,
            batchSize: 1,
            dryRun: true,
            maxDeletesPerRulePerRun: 2,
        })).resolves.toMatchObject({ deleted: 2 });
        await expect(db.sessionMessage.count()).resolves.toBe(3);

        await expect(runSessionSidechainMessageRetentionRule({
            cutoff,
            batchSize: 1,
            dryRun: false,
            maxDeletesPerRulePerRun: 2,
        })).resolves.toMatchObject({ deleted: 2 });
        await expect(db.sessionMessage.count()).resolves.toBe(1);
    });

    it('continues from its persisted sidechain cursor instead of rescanning the first candidate', async () => {
        await createSession('target', 2);
        await createMessage({ sessionId: 'target', seq: 1, sidechainId: 'a-recent', createdAt: recent });
        await createMessage({ sessionId: 'target', seq: 2, sidechainId: 'b-expired', createdAt: old });

        const { runSessionSidechainMessageRetentionRule } = await import('./sessionSidechainMessageRetentionRule');
        await expect(runSessionSidechainMessageRetentionRule({
            cutoff,
            batchSize: 1,
            dryRun: false,
            maxDeletesPerRulePerRun: 10,
        })).resolves.toMatchObject({ deleted: 0 });

        await expect(runSessionSidechainMessageRetentionRule({
            cutoff,
            batchSize: 1,
            dryRun: false,
            maxDeletesPerRulePerRun: 10,
        })).resolves.toMatchObject({ deleted: 1 });
        await expect(db.sessionMessage.findMany({
            orderBy: { seq: 'asc' },
            select: { sidechainId: true },
        })).resolves.toEqual([{ sidechainId: 'a-recent' }]);
    });

    it('yields between sidechain candidates when the sweep time budget expires', async () => {
        await createSession('target', 2);
        await createMessage({ sessionId: 'target', seq: 1, sidechainId: 'a-recent', createdAt: recent });
        await createMessage({ sessionId: 'target', seq: 2, sidechainId: 'b-expired', createdAt: old });
        let checks = 0;

        const { runSessionSidechainMessageRetentionRule } = await import('./sessionSidechainMessageRetentionRule');
        const result = await runSessionSidechainMessageRetentionRule({
            cutoff,
            batchSize: 500,
            dryRun: false,
            maxDeletesPerRulePerRun: 100_000,
            maxCandidatesPerRulePerRun: 10_000,
            shouldContinue: () => checks++ === 0,
        });

        expect(result).toMatchObject({ deleted: 0, candidatesExamined: 1, hasMore: true });
        await expect(db.sessionMessage.count()).resolves.toBe(2);
    });

    it('preserves an expired sidechain while a recoverable historical-import job owns it, while continuing unrelated retention', async () => {
        const ownedSession = await db.session.create({
            data: {
                id: 'a-owned-import',
                tag: 'a-owned-import',
                accountId: 'owner',
                metadata: '{}',
                encryptionMode: 'plain',
                currentStorageState: 'machine_only',
                active: true,
                lastActiveAt: recent,
                updatedAt: recent,
            },
            select: { id: true },
        });
        const claim = {
            sessionId: ownedSession.id,
            operationId: 'retention-owned-operation',
            operationClaimId: 'retention-owned-claim',
        } as const;
        const execute = async (command: unknown) => await executeExternalSessionHistoricalImportCommand({
            actorUserId: 'owner',
            transportMachineId: 'retention-machine',
            limits: { maxItems: 200, maxSerializedBytes: 512 * 1024 },
            command,
        });

        await expect(execute({
            v: 1,
            kind: 'begin',
            claim,
            expectedRevision: 0,
            expectedPriorStableStorage: { state: 'machine_only' },
        })).resolves.toMatchObject({ kind: 'ready' });
        await expect(execute({
            v: 1,
            kind: 'batch',
            claim,
            expectedRevision: 0,
            batchId: makeExternalSessionHistoricalImportBatchIdV1(['owned:1']),
            items: [{
                localId: 'owned:1',
                sidechainId: 'operation-owned',
                messageRole: 'agent',
                content: { t: 'plain', v: { text: 'recoverable historical row' } },
            }],
        })).resolves.toMatchObject({
            kind: 'batch_accepted',
            acceptedThroughServerSeq: 1,
        });
        await db.sessionMessage.updateMany({
            where: { sessionId: ownedSession.id, sidechainId: 'operation-owned' },
            data: { createdAt: old },
        });

        await createSession('z-unowned-expired', 1);
        await createMessage({
            sessionId: 'z-unowned-expired',
            seq: 1,
            sidechainId: 'ordinary-expired',
            createdAt: old,
        });

        const { runSessionSidechainMessageRetentionRule } = await import('./sessionSidechainMessageRetentionRule');
        await expect(runSessionSidechainMessageRetentionRule({
            cutoff,
            batchSize: 10,
            dryRun: false,
            maxDeletesPerRulePerRun: 10,
            maxCandidatesPerRulePerRun: 10,
        })).resolves.toMatchObject({ deleted: 1 });
        await expect(db.sessionMessage.findMany({
            where: { sessionId: ownedSession.id },
            select: { localId: true, sidechainId: true },
        })).resolves.toEqual([{ localId: 'owned:1', sidechainId: 'operation-owned' }]);
        await expect(db.sessionMessage.count({ where: { sessionId: 'z-unowned-expired' } })).resolves.toBe(0);

        await expect(execute({
            v: 1,
            kind: 'discard',
            claim,
            expectedRevision: 0,
        })).resolves.toMatchObject({ kind: 'discarded' });
        await expect(db.sessionMessage.count({ where: { sessionId: ownedSession.id } })).resolves.toBe(0);
    });
});
