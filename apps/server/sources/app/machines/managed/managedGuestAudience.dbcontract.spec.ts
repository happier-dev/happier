import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, initDbMysql, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { readMachineAudienceAccountIdsInTx, readMachineRecipientWorkInTx } from '@/app/machines/machineRecipientWork';

describe('Machine audience SQL across database providers', () => {
    beforeAll(async () => {
        const postgres = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        const mysql = process.env.HAPPIER_TEST_MYSQL_DATABASE_URL;
        if (!process.env.DATABASE_URL || process.env.DATABASE_URL !== (postgres ?? mysql)) {
            throw new Error('Use the disposable DB-contract harness');
        }
        if (postgres) initDbPostgres();
        else await initDbMysql();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it('includes direct Use and Manage grantees with a known custodian', async () => {
        const [custodian, viewer, manager] = await Promise.all([
            db.account.create({ data: { encryptionMode: 'plain' } }),
            db.account.create({ data: { encryptionMode: 'plain' } }),
            db.account.create({ data: { encryptionMode: 'plain' } }),
        ]);
        const machine = await db.machine.create({ data: { id: `m_${randomUUID().slice(0, 12)}`, accountId: custodian.id,
            metadata: '{}', installationId: randomUUID() } });
        await db.machineAccountGrant.createMany({ data: [
            { machineId: machine.id, accountId: viewer.id, createdByAccountId: custodian.id, accessLevel: 'view' },
            { machineId: machine.id, accountId: manager.id, createdByAccountId: custodian.id, accessLevel: 'admin' },
        ] });
        const audience = (knownCustodian?: string) => inTx(tx => readMachineAudienceAccountIdsInTx(tx, machine.id, knownCustodian));
        expect(await audience()).toEqual([custodian.id, viewer.id, manager.id].sort());
        expect(await audience(custodian.id)).toEqual(await audience());
    });

    it('returns positive recipient work for two ordinary owned Machines without mixing their grantees', async () => {
        const [owner, viewer, manager] = await Promise.all([
            db.account.create({ data: { encryptionMode: 'plain' } }),
            db.account.create({ data: { encryptionMode: 'plain' } }),
            db.account.create({ data: { encryptionMode: 'plain' } }),
        ]);
        const machines = await Promise.all([0, 1].map(() => db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, metadata: '{}', installationId: randomUUID(),
        } })));
        await db.machineAccountGrant.createMany({ data: [
            { machineId: machines[0].id, accountId: viewer.id, createdByAccountId: owner.id, accessLevel: 'view' },
            { machineId: machines[1].id, accountId: manager.id, createdByAccountId: owner.id, accessLevel: 'admin' },
        ] });
        const work = await inTx(tx => readMachineRecipientWorkInTx(tx, { actorAccountId: owner.id,
            ownerFingerprints: new Map(machines.map(machine => [machine.id, null])) }));
        expect([...work.keys()].sort()).toEqual(machines.map(machine => machine.id).sort());
        expect(work.get(machines[0].id)?.recipients.map(recipient => recipient.recipientAccountId)).toEqual([viewer.id]);
        expect(work.get(machines[1].id)?.recipients.map(recipient => recipient.recipientAccountId)).toEqual([manager.id]);
    });
});
