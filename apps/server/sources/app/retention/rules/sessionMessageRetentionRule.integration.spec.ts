import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

describe('sessionMessageRetentionRule', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'retention-session-message-rule-',
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
            () => db.sessionMessage.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
        await db.account.create({
            data: { id: 'owner' },
        });
    });

    async function createSession(params: Readonly<{
        id: string;
        active: boolean;
        lastActiveAt: Date;
        updatedAt: Date;
        seq?: number;
        lastViewedSessionSeq?: number | null;
        latestReadyEventSeq?: number | null;
    }>) {
        await db.session.create({
            data: {
                id: params.id,
                tag: params.id,
                accountId: 'owner',
                metadata: '{}',
                active: params.active,
                lastActiveAt: params.lastActiveAt,
                updatedAt: params.updatedAt,
                seq: params.seq ?? 0,
                lastViewedSessionSeq: params.lastViewedSessionSeq ?? null,
                latestReadyEventSeq: params.latestReadyEventSeq ?? null,
            },
        });
    }

    async function createMessage(params: Readonly<{
        sessionId: string;
        seq: number;
        createdAt: Date;
        content: PrismaJson.SessionMessageContent;
    }>) {
        await db.sessionMessage.create({
            data: {
                sessionId: params.sessionId,
                seq: params.seq,
                createdAt: params.createdAt,
                content: params.content,
            },
        });
    }

    it('prunes only old inactive messages below session watermarks and keeps reads correct', async () => {
        const old = new Date('2025-01-01T00:00:00.000Z');
        const recent = new Date('2027-01-01T00:00:00.000Z');
        const cutoff = new Date('2026-01-01T00:00:00.000Z');

        await createSession({
            id: 'stale',
            active: false,
            lastActiveAt: old,
            updatedAt: old,
            seq: 5,
            lastViewedSessionSeq: 3,
            latestReadyEventSeq: 4,
        });
        await createSession({
            id: 'active',
            active: true,
            lastActiveAt: old,
            updatedAt: old,
            seq: 5,
            lastViewedSessionSeq: 3,
        });
        await createSession({
            id: 'recent-inactive',
            active: false,
            lastActiveAt: recent,
            updatedAt: recent,
            seq: 5,
            lastViewedSessionSeq: 3,
        });
        await createSession({
            id: 'recent-message',
            active: false,
            lastActiveAt: old,
            updatedAt: old,
            seq: 3,
            lastViewedSessionSeq: 3,
        });

        for (const seq of [1, 2, 3, 4, 5]) {
            await createMessage({
                sessionId: 'stale',
                seq,
                createdAt: old,
                content: seq % 2 === 0
                    ? { t: 'encrypted', c: `cipher-${seq}` }
                    : { t: 'plain', v: { text: `plain-${seq}` } },
            });
        }
        await createMessage({
            sessionId: 'active',
            seq: 1,
            createdAt: old,
            content: { t: 'plain', v: { text: 'active' } },
        });
        await createMessage({
            sessionId: 'recent-inactive',
            seq: 1,
            createdAt: old,
            content: { t: 'plain', v: { text: 'recent-session' } },
        });
        await createMessage({
            sessionId: 'recent-message',
            seq: 1,
            createdAt: recent,
            content: { t: 'plain', v: { text: 'recent-message' } },
        });

        const { pruneSessionMessagesOnce } = await import('./sessionMessageRetentionRule');
        const result = await pruneSessionMessagesOnce({
            cutoff,
            batchSize: 10,
            dryRun: false,
            minTailMessages: 1,
        });

        expect(result.deleted).toBe(2);
        await expect(db.sessionMessage.findMany({
            where: { sessionId: 'stale' },
            orderBy: { seq: 'asc' },
            select: { seq: true, content: true },
        })).resolves.toEqual([
            { seq: 3, content: { t: 'plain', v: { text: 'plain-3' } } },
            { seq: 4, content: { t: 'encrypted', c: 'cipher-4' } },
            { seq: 5, content: { t: 'plain', v: { text: 'plain-5' } } },
        ]);
        await expect(db.sessionMessage.count({ where: { sessionId: 'active' } })).resolves.toBe(1);
        await expect(db.sessionMessage.count({ where: { sessionId: 'recent-inactive' } })).resolves.toBe(1);
        await expect(db.sessionMessage.count({ where: { sessionId: 'recent-message' } })).resolves.toBe(1);
    });

    it('paginates past empty stale sessions and uses the full per-rule delete allowance', async () => {
        const old = new Date('2025-01-01T00:00:00.000Z');
        const cutoff = new Date('2026-01-01T00:00:00.000Z');

        await createSession({ id: 'a-empty', active: false, lastActiveAt: old, updatedAt: old, seq: 0 });
        for (const id of ['b-target', 'c-target', 'd-target']) {
            await createSession({ id, active: false, lastActiveAt: old, updatedAt: old, seq: 501 });
            await createMessage({
                sessionId: id,
                seq: 1,
                createdAt: old,
                content: { t: 'plain', v: { text: id } },
            });
        }

        const { runSessionMessageRetentionRule } = await import('./sessionMessageRetentionRule');
        await expect(runSessionMessageRetentionRule({
            cutoff,
            batchSize: 1,
            dryRun: false,
            maxDeletesPerRulePerRun: 3,
        })).resolves.toMatchObject({ deleted: 3 });
        await expect(db.sessionMessage.count()).resolves.toBe(0);
    });

    it('continues a dry run after the last counted message instead of recounting it', async () => {
        const old = new Date('2025-01-01T00:00:00.000Z');
        const cutoff = new Date('2026-01-01T00:00:00.000Z');
        await createSession({ id: 'target', active: false, lastActiveAt: old, updatedAt: old, seq: 503 });
        for (const seq of [1, 2, 3]) {
            await createMessage({
                sessionId: 'target',
                seq,
                createdAt: old,
                content: { t: 'plain', v: { text: `${seq}` } },
            });
        }

        const { runSessionMessageRetentionRule } = await import('./sessionMessageRetentionRule');
        const first = await runSessionMessageRetentionRule({
            cutoff,
            batchSize: 2,
            dryRun: true,
            maxDeletesPerRulePerRun: 2,
            startCursor: null,
        });
        const second = await runSessionMessageRetentionRule({
            cutoff,
            batchSize: 2,
            dryRun: true,
            maxDeletesPerRulePerRun: 2,
            startCursor: first.nextCursor,
        });

        expect(first).toMatchObject({ deleted: 2, candidatesExamined: 2, hasMore: true });
        expect(second).toMatchObject({ deleted: 1, candidatesExamined: 1, hasMore: false });
        await expect(db.sessionMessage.count()).resolves.toBe(3);
    });
});
