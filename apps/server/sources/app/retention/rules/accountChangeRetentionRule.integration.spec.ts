import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

describe('accountChangeRetentionRule', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'retention-account-change-rule-',
        });
    });

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(async () => {
        harness.restoreEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it('deletes aged account changes per account and advances changesFloor to the highest pruned cursor', async () => {
        await db.account.createMany({
            data: [
                { id: 'owner-a' },
                { id: 'owner-b' },
            ],
        });

        await db.accountChange.createMany({
            data: [
                {
                    accountId: 'owner-a',
                    kind: 'session',
                    entityId: 'a-1',
                    cursor: 1,
                    changedAt: new Date('2024-01-01T00:00:00.000Z'),
                },
                {
                    accountId: 'owner-a',
                    kind: 'session',
                    entityId: 'a-2',
                    cursor: 2,
                    changedAt: new Date('2024-01-02T00:00:00.000Z'),
                },
                {
                    accountId: 'owner-a',
                    kind: 'session',
                    entityId: 'a-3',
                    cursor: 3,
                    changedAt: new Date('2026-01-01T00:00:00.000Z'),
                },
                {
                    accountId: 'owner-b',
                    kind: 'session',
                    entityId: 'b-1',
                    cursor: 4,
                    changedAt: new Date('2024-01-03T00:00:00.000Z'),
                },
            ],
        });

        const { runAccountChangeRetentionRule } = await import('./accountChangeRetentionRule');
        const result = await runAccountChangeRetentionRule({
            cutoff: new Date('2025-01-01T00:00:00.000Z'),
            batchSize: 10,
            dryRun: false,
            maxDeletesPerRulePerRun: 10,
        });

        expect(result.deleted).toBe(3);
        expect(await db.accountChange.count()).toBe(1);
        expect(await db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId: 'owner-a',
                    kind: 'session',
                    entityId: 'a-3',
                },
            },
        })).toBeTruthy();
        expect(await db.account.findUnique({ where: { id: 'owner-a' }, select: { changesFloor: true } })).toEqual({
            changesFloor: 2,
        });
        expect(await db.account.findUnique({ where: { id: 'owner-b' }, select: { changesFloor: true } })).toEqual({
            changesFloor: 4,
        });
    });

    it('reports aged account changes in dry-run mode without deleting rows or changing floors', async () => {
        await db.account.create({
            data: { id: 'owner-a' },
        });
        await db.accountChange.create({
            data: {
                accountId: 'owner-a',
                kind: 'session',
                entityId: 'a-1',
                cursor: 1,
                changedAt: new Date('2024-01-01T00:00:00.000Z'),
            },
        });

        const { runAccountChangeRetentionRule } = await import('./accountChangeRetentionRule');
        const result = await runAccountChangeRetentionRule({
            cutoff: new Date('2025-01-01T00:00:00.000Z'),
            batchSize: 10,
            dryRun: true,
            maxDeletesPerRulePerRun: 10,
        });

        expect(result.deleted).toBe(1);
        expect(await db.accountChange.count()).toBe(1);
        expect(await db.account.findUnique({ where: { id: 'owner-a' }, select: { changesFloor: true } })).toEqual({
            changesFloor: 0,
        });
    });

    it('respects maxDeletesPerRulePerRun with deterministic oldest-first per-account windows', async () => {
        await db.account.createMany({
            data: [
                { id: 'owner-a' },
                { id: 'owner-b' },
            ],
        });

        await db.accountChange.createMany({
            data: [
                {
                    accountId: 'owner-a',
                    kind: 'session',
                    entityId: 'a-1',
                    cursor: 1,
                    changedAt: new Date('2024-01-01T00:00:00.000Z'),
                },
                {
                    accountId: 'owner-a',
                    kind: 'session',
                    entityId: 'a-2',
                    cursor: 2,
                    changedAt: new Date('2024-01-02T00:00:00.000Z'),
                },
                {
                    accountId: 'owner-a',
                    kind: 'session',
                    entityId: 'a-3',
                    cursor: 3,
                    changedAt: new Date('2024-01-03T00:00:00.000Z'),
                },
                {
                    accountId: 'owner-b',
                    kind: 'session',
                    entityId: 'b-1',
                    cursor: 4,
                    changedAt: new Date('2024-01-04T00:00:00.000Z'),
                },
            ],
        });

        const { runAccountChangeRetentionRule } = await import('./accountChangeRetentionRule');
        const result = await runAccountChangeRetentionRule({
            cutoff: new Date('2025-01-01T00:00:00.000Z'),
            batchSize: 10,
            dryRun: false,
            maxDeletesPerRulePerRun: 2,
        });

        expect(result.deleted).toBe(2);
        expect(await db.accountChange.findMany({
            orderBy: [{ accountId: 'asc' }, { cursor: 'asc' }],
            select: { accountId: true, entityId: true, cursor: true },
        })).toEqual([
            { accountId: 'owner-a', entityId: 'a-3', cursor: 3 },
            { accountId: 'owner-b', entityId: 'b-1', cursor: 4 },
        ]);
        expect(await db.account.findUnique({ where: { id: 'owner-a' }, select: { changesFloor: true } })).toEqual({
            changesFloor: 2,
        });
        expect(await db.account.findUnique({ where: { id: 'owner-b' }, select: { changesFloor: true } })).toEqual({
            changesFloor: 0,
        });
    });
});
