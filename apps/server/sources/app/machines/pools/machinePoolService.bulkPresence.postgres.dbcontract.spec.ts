import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { getMachinePoolCandidateSnapshots } from './machinePoolService';
import { serializePrivateLabelStoredV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { createDbMaintenanceClient, onDbClientQuery, type PrismaClientType } from '@/storage/prisma';

function storedPlainPoolLabel(value: string): string {
    return serializePrivateLabelStoredV1({ content: { t: 'plain', v: value }, recipients: [] });
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Bulk Pool snapshot native SQL (PostgreSQL)', () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClientType;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use only the canonical disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        client = await createDbMaintenanceClient('postgres', undefined, { log: [{ emit: 'event', level: 'query' }] });
        onDbClientQuery(client, event => statements.push(event));
        await client.$connect();
    });
    afterAll(async () => { await client?.$disconnect(); await shutdownDbClient(); });

    it('bounds an inventory-sized owned Pool selector without losing first or last results', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, metadata: '{}',
            operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: '1'.repeat(64) } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const ids = Array.from({ length: 1100 }, () => randomUUID());
        await db.machinePool.createMany({ data: ids.map((id, index) => ({ id, accountId: owner.id, name: storedPlainPoolLabel(`Pool ${index}`), revision: index })) });
        await db.machinePoolMember.createMany({ data: ids.map(poolId => ({ poolId, machineId: machine.id, priorityTier: 0, enabled: true })) });
        const foreign = await db.machinePool.create({ data: { id: randomUUID(), accountId: other.id, name: storedPlainPoolLabel('Foreign Pool') } });
        const missing = randomUUID();
        const pool = db.machinePool;
        const original = pool.findMany;
        // Redirect only the genuine persistence transport; retain real Pool policy,
        // query arguments, native Prisma SQL, rows and candidate projection.
        pool.findMany = new Proxy(original, { apply(_target, _receiver, args) {
            return Reflect.apply(client.machinePool.findMany, client.machinePool, args);
        } });
        try {
            statements.length = 0;
            const snapshots = await getMachinePoolCandidateSnapshots({ accountId: owner.id,
                poolIds: [...ids, ids[0]!, foreign.id, missing], presence: { state: 'known', machineIds: new Set([machine.id]) } });
            expect(snapshots.size).toBe(ids.length);
            for (const index of [0, ids.length - 1]) expect(snapshots.get(ids[index]!)).toMatchObject({
                poolId: ids[index], revision: index, availableMachineIds: new Set([machine.id]), presenceState: 'known',
                machineEndpointIds: new Map([[machine.id, '1'.repeat(64)]]),
            });
            expect(snapshots.has(foreign.id)).toBe(false);
            expect(snapshots.has(missing)).toBe(false);
            const selects = statements.filter(event => /^SELECT\b/i.test(event.query));
            expect(selects.length, 'Native database instrumentation must observe the selector').toBeGreaterThan(0);
            const bindings = selects.map(event => (JSON.parse(event.params) as unknown[]).length);
            console.info('BULK_POOL_BIND_SQL', JSON.stringify({ requested: ids.length + 2, returned: snapshots.size, selects: selects.length, bindings }));
            expect.soft(selects).toHaveLength(2);
            expect.soft(Math.max(...bindings)).toBeLessThanOrEqual(999);
        } finally { pool.findMany = original; }
    });
});
