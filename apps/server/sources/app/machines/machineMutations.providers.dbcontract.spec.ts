import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';

import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createMachineWithInstallationIdentityInTx } from './machineMutations';

const provider = getDbProviderFromEnv(process.env, 'postgres');

describe.skipIf(provider !== 'postgres' && provider !== 'mysql')('Machine creation observation epochs (real database)', () => {
    let connected = false;

    beforeAll(async () => {
        const testUrl = provider === 'postgres'
            ? process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            : process.env.HAPPIER_TEST_MYSQL_DATABASE_URL;
        if (!testUrl || process.env.DATABASE_URL !== testUrl) {
            throw new Error('Run with the disposable provider DB-contract harness');
        }
        if (provider === 'postgres') initDbPostgres();
        else await initDbMysql();
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (connected) await shutdownDbClient();
    });

    it.each(['persistent', 'ephemeral_session_runner'] as const)(
        'creates an inactive %s with the actual UTC observation in a non-UTC database session', async kind => {
            const account = await db.account.create({ data: { encryptionMode: 'plain' } });
            const machineId = randomUUID();
            try {
                const before = Date.now();
                const created = await inTx(async tx => {
                    let originalTimeZone: string | undefined;
                    if (provider === 'postgres') {
                        await tx.$executeRaw`SET LOCAL TimeZone = 'Europe/Amsterdam'`;
                        expect(await tx.$queryRaw<Array<{ TimeZone: string }>>`SHOW TimeZone`)
                            .toEqual([{ TimeZone: 'Europe/Amsterdam' }]);
                    } else {
                        const [current] = await tx.$queryRaw<Array<{ timeZone: string }>>`SELECT @@session.time_zone AS timeZone`;
                        originalTimeZone = current!.timeZone;
                        await tx.$executeRaw`SET time_zone = '+05:30'`;
                        expect(await tx.$queryRaw<Array<{ timeZone: string }>>`SELECT @@session.time_zone AS timeZone`)
                            .toEqual([{ timeZone: '+05:30' }]);
                    }
                    try {
                        return await createMachineWithInstallationIdentityInTx(tx, {
                            accountId: account.id, machineId, kind,
                            metadata: encodePlainMachineStoredContent({ host: 'creation-clock' }),
                            daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                            installationIdentity: null, contentPublicKeyFingerprint: null,
                            replacementReason: 'machine_rotation',
                        });
                    } finally {
                        if (originalTimeZone !== undefined) await tx.$executeRaw`SET time_zone = ${originalTimeZone}`;
                    }
                });
                const after = Date.now();
                const persisted = await db.machine.findUniqueOrThrow({ where: { id: machineId },
                    select: { active: true, lastActiveAt: true } });

                expect(created.machine.active).toBe(false);
                expect(persisted.active).toBe(false);
                expect(persisted.lastActiveAt).toEqual(created.machine.lastActiveAt);
                expect(persisted.lastActiveAt.getTime()).toBeGreaterThanOrEqual(before);
                expect(persisted.lastActiveAt.getTime()).toBeLessThanOrEqual(after);
            } finally {
                await db.accountChange.deleteMany({ where: { accountId: account.id } });
                await db.machine.deleteMany({ where: { accountId: account.id } });
                await db.account.delete({ where: { id: account.id } });
            }
        },
    );

    it.skipIf(provider !== 'postgres')('preserves the actual UTC observation in a daemon-state Prisma update in a non-UTC database session', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machineId = randomUUID();
        try {
            const observedAt = await inTx(async tx => {
                await tx.$executeRaw`SET LOCAL TimeZone = 'Europe/Amsterdam'`;
                expect(await tx.$queryRaw<Array<{ TimeZone: string }>>`SHOW TimeZone`)
                    .toEqual([{ TimeZone: 'Europe/Amsterdam' }]);
                const { machine } = await createMachineWithInstallationIdentityInTx(tx, {
                    accountId: account.id, machineId, kind: 'persistent',
                    metadata: encodePlainMachineStoredContent({ host: 'daemon-update-clock' }),
                    daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                    installationIdentity: null, contentPublicKeyFingerprint: null,
                    replacementReason: 'machine_rotation',
                });
                const timestamp = Date.now();
                const updated = await tx.machine.updateMany({
                    where: {
                        accountId: account.id, id: machineId,
                        daemonStateVersion: machine.daemonStateVersion,
                        dataEncryptionKey: machine.dataEncryptionKey,
                        installationId: machine.installationId,
                        revokedAt: null, replacedByMachineId: null,
                    },
                    data: {
                        daemonState: encodePlainMachineStoredContent({ pid: 1 }),
                        daemonStateVersion: machine.daemonStateVersion + 1,
                        active: true, lastActiveAt: new Date(timestamp),
                    },
                });
                expect(updated.count).toBe(1);
                return timestamp;
            });
            const persisted = await db.machine.findUniqueOrThrow({ where: { id: machineId },
                select: { active: true, lastActiveAt: true, daemonStateVersion: true } });
            expect(persisted.active).toBe(true);
            expect(persisted.daemonStateVersion).toBe(1);
            expect(persisted.lastActiveAt.getTime()).toBe(observedAt);
        } finally {
            await db.accountChange.deleteMany({ where: { accountId: account.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
