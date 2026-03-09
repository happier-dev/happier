import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { activityCache } from '@/app/presence/sessionCache';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

const emitUpdate = vi.fn();
vi.mock('@/app/events/eventRouter', async () => {
    const actual = await vi.importActual<typeof import('@/app/events/eventRouter')>('@/app/events/eventRouter');
    return {
        ...actual,
        eventRouter: {
            ...actual.eventRouter,
            emitUpdate,
        },
    };
});

describe('sessionRetentionRule', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'retention-session-rule-',
        });
    });

    afterAll(async () => {
        activityCache.shutdown();
        await harness.close();
    });

    beforeEach(async () => {
        emitUpdate.mockReset();
        activityCache.shutdown();
        harness.restoreEnv();
        await harness.resetDbTables([
            () => db.publicShareAccessLog.deleteMany(),
            () => db.publicSessionShare.deleteMany(),
            () => db.sessionShareAccessLog.deleteMany(),
            () => db.sessionShare.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.usageReport.deleteMany(),
            () => db.sessionMessage.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it('deletes stale sessions and their owned rows using the shared delete flow', async () => {
        await db.account.createMany({
            data: [
                { id: 'owner' },
                { id: 'u2' },
            ],
        });

        await db.session.create({
            data: {
                id: 's1',
                tag: 'retention-target',
                accountId: 'owner',
                metadata: '{}',
                active: false,
            },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: 's1',
                seq: 1,
                content: { t: 'plain', v: { role: 'user', text: 'hello' } },
            },
        });
        await db.usageReport.create({
            data: {
                key: 'usage-1',
                accountId: 'owner',
                sessionId: 's1',
                data: {
                    tokens: { total: 3 },
                    cost: { total: 0 },
                },
            },
        });
        await db.sessionShare.create({
            data: {
                sessionId: 's1',
                sharedByUserId: 'owner',
                sharedWithUserId: 'u2',
            },
        });

        const { pruneInactiveSessionsOnce } = await import('./sessionRetentionRule');
        const result = await pruneInactiveSessionsOnce({
            cutoff: new Date('2027-02-01T00:00:00.000Z'),
            batchSize: 10,
            dryRun: false,
        });

        expect(result.deleted).toBe(1);
        expect(await db.session.findUnique({ where: { id: 's1' } })).toBeNull();
        expect(await db.sessionMessage.count({ where: { sessionId: 's1' } })).toBe(0);
        expect(await db.usageReport.count({ where: { sessionId: 's1' } })).toBe(0);
        expect(await db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId: 'owner',
                    kind: 'session',
                    entityId: 's1',
                },
            },
        })).toBeTruthy();
        expect(await db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId: 'u2',
                    kind: 'session',
                    entityId: 's1',
                },
            },
        })).toBeTruthy();
        expect(emitUpdate).toHaveBeenCalledTimes(2);
    });

    it('skips sessions that are currently observed as active by the runtime cache', async () => {
        await db.account.create({
            data: { id: 'owner' },
        });

        await db.session.create({
            data: {
                id: 's1',
                tag: 'retention-active-cache',
                accountId: 'owner',
                metadata: '{}',
                active: true,
                lastActiveAt: new Date('2025-01-01T00:00:00.000Z'),
                updatedAt: new Date('2025-01-01T00:00:00.000Z'),
            },
        });

        await expect(activityCache.isSessionValid('s1', 'owner')).resolves.toBe(true);

        const { pruneInactiveSessionsOnce } = await import('./sessionRetentionRule');
        const result = await pruneInactiveSessionsOnce({
            cutoff: new Date('2027-02-01T00:00:00.000Z'),
            batchSize: 10,
            dryRun: false,
        });

        expect(result.deleted).toBe(0);
        expect(await db.session.findUnique({ where: { id: 's1' } })).toBeTruthy();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it('skips sessions that are still marked active even when timestamps are stale', async () => {
        await db.account.create({
            data: { id: 'owner' },
        });

        await db.session.create({
            data: {
                id: 's1',
                tag: 'retention-active-flag',
                accountId: 'owner',
                metadata: '{}',
                active: true,
                lastActiveAt: new Date('2025-01-01T00:00:00.000Z'),
                updatedAt: new Date('2025-01-01T00:00:00.000Z'),
            },
        });

        const { pruneInactiveSessionsOnce } = await import('./sessionRetentionRule');
        const result = await pruneInactiveSessionsOnce({
            cutoff: new Date('2027-02-01T00:00:00.000Z'),
            batchSize: 10,
            dryRun: false,
        });

        expect(result.deleted).toBe(0);
        expect(await db.session.findUnique({ where: { id: 's1' } })).toBeTruthy();
        expect(emitUpdate).not.toHaveBeenCalled();
    });
});
