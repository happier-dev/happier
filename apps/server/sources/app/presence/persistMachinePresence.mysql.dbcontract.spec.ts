import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol';

import { db, getDbProviderFromEnv, initDbMysql } from '@/storage/db';
import { inTx, type ResolvedTransactionResult, type Tx } from '@/storage/inTx';
import { lockMachinePresenceInTx, markMachinePresenceInactive, persistMachinePresence } from './persistMachinePresence';
import { recordMachineAliveInTx } from './presenceRecorder';
import { stopLocalMachinePresenceTimeout } from './timeout';

async function withNonUtcPresenceTx<T>(run: (tx: Tx) => Promise<T>): Promise<ResolvedTransactionResult<T>> {
    return inTx(async tx => {
        const [{ timeZone }] = await tx.$queryRaw<Array<{ timeZone: string }>>`SELECT @@session.time_zone AS timeZone`;
        try {
            await tx.$executeRaw`SET time_zone = '+05:30'`;
            expect(await tx.$queryRaw<Array<{ timeZone: string }>>`SELECT @@session.time_zone AS timeZone`)
                .toEqual([{ timeZone: '+05:30' }]);
            return await run(tx);
        } finally {
            await tx.$executeRaw`SET time_zone = ${timeZone}`;
        }
    }, { isolationLevel: 'ReadCommitted', transactionClass: 'presence-clock-contract' });
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'mysql')('Machine presence content clocks (real MySQL)', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_MYSQL_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_MYSQL_DATABASE_URL) {
            throw new Error('Run with the disposable MySQL DB-contract harness');
        }
        await initDbMysql();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { await stopLocalMachinePresenceTimeout(); if (connected) await db.$disconnect(); });

    it('acquires admission facts once per beat in a non-UTC session', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const timestamp = Date.now();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', active: true, lastActiveAt: new Date(timestamp - 1_000) } });
        let acquisitions = 0;
        for (let beat = 0; beat < 3; beat++) await withNonUtcPresenceTx(async tx => {
            const observed = new Proxy(tx, { get(target, property, receiver) {
                if (property === '$queryRaw') return new Proxy(target.$queryRaw, { apply(query, queryReceiver, args) {
                    acquisitions++;
                    return Reflect.apply(query, queryReceiver, args);
                } });
                if (property !== 'machine') return Reflect.get(target, property, receiver);
                return new Proxy(target.machine, { get(delegate, method, delegateReceiver) {
                    const operation = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== 'findUnique') return operation;
                    return (...args: Parameters<typeof tx.machine.findUnique>) => {
                        acquisitions++;
                        return Reflect.apply(operation, delegate, args);
                    };
                } });
            } });
            expect(await recordMachineAliveInTx(observed, { accountId: owner.id, machineId: machine.id, timestamp },
                async (_, row) => {
                    expect(row).toMatchObject({ accountId: owner.id, active: true, revokedAt: null, replacedByMachineId: null });
                    return { recipientAccountIds: [owner.id], wasOffline: !row.active, lastActiveAt: row.lastActiveAt };
                })).not.toBeNull();
        });
        expect(acquisitions).toBe(3);
        expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id }, select: { active: true, lastActiveAt: true } }))
            .toEqual({ active: true, lastActiveAt: new Date(timestamp) });
    });

    it('keeps 137 Machines renewing for 300 seconds out of content clocks and Account changes', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machineIds = Array.from({ length: 137 }, () => randomUUID());
        const contentAt = new Date('2025-01-01T00:00:00.000Z');
        const base = Date.now() - 300_000;
        await db.machine.createMany({ data: machineIds.map(id => ({
            id, accountId: owner.id, active: true, lastActiveAt: new Date(base), updatedAt: contentAt,
            metadata: encodePlainMachineStoredContent({ host: 'presence-host', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
        })) });
        const before = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });
        const changesBefore = await db.accountChange.count({ where: { accountId: owner.id } });
        for (let elapsed = 20_000; elapsed <= 300_000; elapsed += 20_000) {
            await withNonUtcPresenceTx(async tx => {
                for (const machineId of machineIds) await persistMachinePresence(tx, {
                    accountId: owner.id, machineId, timestamp: base + elapsed,
                });
            });
        }
        expect(await db.machine.count({ where: { accountId: owner.id, updatedAt: { not: contentAt } } })).toBe(0);
        expect(await db.machine.count({ where: { accountId: owner.id, active: true, lastActiveAt: new Date(base + 300_000) } })).toBe(137);
        expect(await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } })).toEqual(before);
        expect(await db.accountChange.count({ where: { accountId: owner.id } })).toBe(changesBefore);

        const machineId = machineIds[0]!;
        const changed = await db.machine.update({ where: { id: machineId }, data: { metadata: 'changed-content' } });
        await persistMachinePresence(db, { accountId: owner.id, machineId, timestamp: base + 320_000 });
        expect(await db.machine.findUniqueOrThrow({ where: { id: machineId }, select: { metadata: true, updatedAt: true, lastActiveAt: true } }))
            .toEqual({ metadata: changed.metadata, updatedAt: changed.updatedAt, lastActiveAt: new Date(base + 320_000) });
        await db.machine.update({ where: { id: machineId }, data: { active: false } });
        const inactive = await db.machine.findUniqueOrThrow({ where: { id: machineId }, select: { updatedAt: true } });
        await persistMachinePresence(db, { accountId: owner.id, machineId, timestamp: base + 320_000 });
        expect(await db.machine.findUniqueOrThrow({ where: { id: machineId }, select: { active: true, updatedAt: true } }))
            .toEqual({ active: true, updatedAt: inactive.updatedAt });
    });

    it('expires only the exact current observation without changing UTC last-seen or content clocks in a non-UTC session', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const lastActiveAt = new Date('2026-10-25T00:59:59.123Z');
        const contentAt = new Date('2025-01-01T00:00:00.456Z');
        const [current, stale, revoked, replaced, wrongAccount] = await Promise.all(
            Array.from({ length: 5 }, () => db.machine.create({ data: {
                id: randomUUID(), accountId: owner.id, active: true, lastActiveAt, updatedAt: contentAt, metadata: 'presence-content',
            } })),
        );
        await db.machine.update({ where: { id: revoked!.id }, data: { revokedAt: new Date(), updatedAt: contentAt } });
        await db.machine.update({ where: { id: replaced!.id }, data: { replacedByMachineId: current!.id, updatedAt: contentAt } });
        await withNonUtcPresenceTx(async tx => {
            expect(await markMachinePresenceInactive(tx, { accountId: owner.id, machineId: current!.id, lastActiveAt })).toBe(1);
            expect(await markMachinePresenceInactive(tx, { accountId: owner.id, machineId: current!.id, lastActiveAt })).toBe(0);
            expect(await markMachinePresenceInactive(tx, { accountId: owner.id, machineId: stale!.id,
                lastActiveAt: new Date(lastActiveAt.getTime() - 1) })).toBe(0);
            for (const machine of [revoked!, replaced!]) {
                expect(await markMachinePresenceInactive(tx, { accountId: owner.id, machineId: machine.id, lastActiveAt })).toBe(0);
            }
            expect(await markMachinePresenceInactive(tx, { accountId: stranger.id, machineId: wrongAccount!.id, lastActiveAt })).toBe(0);
        });
        const rows = await db.machine.findMany({ where: { accountId: owner.id },
            select: { id: true, active: true, lastActiveAt: true, updatedAt: true, metadata: true } });
        expect(rows).toHaveLength(5);
        for (const row of rows) expect(row).toEqual({ id: row.id, active: row.id !== current!.id,
            lastActiveAt, updatedAt: contentAt, metadata: 'presence-content' });
        expect(await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } })).toEqual({ seq: 0 });
        expect(await db.accountChange.count({ where: { accountId: owner.id } })).toBe(0);
    });

    it('allows exactly one concurrent inactive CAS winner in non-UTC sessions', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const lastActiveAt = new Date('2026-10-25T01:00:00.789Z');
        const contentAt = new Date('2025-01-01T00:00:00.456Z');
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, active: true, lastActiveAt, updatedAt: contentAt, metadata: 'presence-content',
        } });
        let release!: () => void;
        const ready = new Promise<void>(resolve => { release = resolve; });
        let entrants = 0;
        const results = await Promise.all(Array.from({ length: 2 }, () => withNonUtcPresenceTx(async tx => {
            if (++entrants === 2) release();
            await ready;
            return markMachinePresenceInactive(tx, { accountId: owner.id, machineId: machine.id, lastActiveAt });
        })));
        expect(results.sort()).toEqual([0, 1]);
        expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
            select: { active: true, lastActiveAt: true, updatedAt: true } }))
            .toEqual({ active: false, lastActiveAt, updatedAt: contentAt });
    });

    it('waits for an admitted renewal row lock before rejecting an old deadline observation', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const scannedAt = new Date(Date.now() - 60_000);
        const renewedAt = new Date(scannedAt.getTime() + 59_999);
        const contentAt = new Date('2025-01-01T00:00:00.456Z');
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, active: true, lastActiveAt: scannedAt, updatedAt: contentAt, metadata: 'presence-content',
        } });
        let pending: Promise<number> | undefined;
        await withNonUtcPresenceTx(async tx => {
            const [{ connectionId }] = await tx.$queryRaw<Array<{ connectionId: bigint }>>`SELECT CONNECTION_ID() AS connectionId`;
            await tx.$queryRaw`SELECT \`id\` FROM \`Machine\` WHERE \`id\` = ${machine.id} FOR UPDATE`;
            expect(await persistMachinePresence(tx, { accountId: owner.id, machineId: machine.id, timestamp: renewedAt.getTime() })).toBe(1);
            let settled = false;
            pending = withNonUtcPresenceTx(async peer => {
                const observed = await lockMachinePresenceInTx(peer, machine.id);
                expect(observed?.lastActiveAt).toEqual(renewedAt);
                expect(await persistMachinePresence(peer, { accountId: owner.id, machineId: machine.id,
                    timestamp: scannedAt.getTime() })).toBe(0);
                return markMachinePresenceInactive(peer, { accountId: owner.id, machineId: machine.id, lastActiveAt: scannedAt });
            }).finally(() => { settled = true; });
            void pending.catch(() => undefined);
            while (!settled) {
                const [state] = await db.$queryRaw<Array<{ blocked: bigint }>>`
                    SELECT COUNT(*) AS blocked FROM performance_schema.data_lock_waits AS waits
                        JOIN performance_schema.threads AS threads ON threads.THREAD_ID = waits.BLOCKING_THREAD_ID
                        WHERE threads.PROCESSLIST_ID = ${connectionId}
                `;
                if (Number(state.blocked) > 0) break;
            }
            expect(settled).toBe(false);
        });
        expect(await pending).toBe(0);
        expect(await db.machine.findUniqueOrThrow({ where: { id: machine.id },
            select: { active: true, lastActiveAt: true, updatedAt: true } }))
            .toEqual({ active: true, lastActiveAt: renewedAt, updatedAt: contentAt });
    });
});
