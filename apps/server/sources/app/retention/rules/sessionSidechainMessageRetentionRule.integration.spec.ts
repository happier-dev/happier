import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.simpleCache.deleteMany(),
            () => db.sessionMessage.deleteMany(),
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

        expect(result).toEqual({ deleted: 2 });
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
        })).resolves.toEqual({ deleted: 2 });
        await expect(db.sessionMessage.count()).resolves.toBe(3);

        await expect(runSessionSidechainMessageRetentionRule({
            cutoff,
            batchSize: 1,
            dryRun: false,
            maxDeletesPerRulePerRun: 2,
        })).resolves.toEqual({ deleted: 2 });
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
        })).resolves.toEqual({ deleted: 0 });

        await expect(runSessionSidechainMessageRetentionRule({
            cutoff,
            batchSize: 1,
            dryRun: false,
            maxDeletesPerRulePerRun: 10,
        })).resolves.toEqual({ deleted: 1 });
        await expect(db.sessionMessage.findMany({
            orderBy: { seq: 'asc' },
            select: { sidechainId: true },
        })).resolves.toEqual([{ sidechainId: 'a-recent' }]);
    });
});
