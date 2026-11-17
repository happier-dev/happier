import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, initDbPostgres } from '@/storage/db';
import { createArtifactResourceSpaceMembershipWhere } from './organizationQueries';
import { mutateResourceSpaceMembership } from './organizationMutations';

describe('personal resource Space query on PostgreSQL', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it('selects a sparse personal member before LIMIT and cascades membership when the resource is deleted', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const old = new Date('2026-01-01T00:00:00Z');
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: account.id, kind: 'review.v1',
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array(), updatedAt: old } });
        await db.artifact.createMany({ data: Array.from({ length: 1000 }, () => ({
            id: randomUUID(), accountId: account.id, kind: 'review.v1', header: new Uint8Array(), body: new Uint8Array(),
            dataEncryptionKey: new Uint8Array(), updatedAt: new Date('2026-02-01T00:00:00Z'),
        })) });
        expect(await mutateResourceSpaceMembership({ accountId: account.id,
            input: { resourceKind: 'artifact', resourceId: artifact.id, operation: 'add', spaceId: 'sparse' } })).toEqual({ changed: true });
        expect(await db.artifact.findMany({ where: { AND: [{ accountId: account.id },
            createArtifactResourceSpaceMembershipWhere({ accountId: account.id, spaceId: 'sparse' })] },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 1, select: { id: true } })).toEqual([{ id: artifact.id }]);
        await db.artifact.delete({ where: { id: artifact.id } });
        expect(await db.resourceSpaceMembership.count({ where: { accountId: account.id } })).toBe(0);
        await db.artifact.deleteMany({ where: { accountId: account.id } });
    });
});
