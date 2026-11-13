import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { pluginCollectionHostReferenceResolver } from '@/app/plugins/data/collections/hostReferenceResolver';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

describe('Machine collection relations through the installed resolver (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-machine-relations-', initAuth: false });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('hides another Account identity while retaining the owning Account relation lifecycle', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'relation-host' }) } });
        const resolve = (accountId: string, targetId = machine.id) => inTx(tx =>
            pluginCollectionHostReferenceResolver.resolveInTx({ tx, accountId, hostKind: 'machine', targetId }));

        expect(await resolve(owner.id)).toEqual({ status: 'available' });
        expect(await resolve(owner.id, randomUUID())).toEqual({ status: 'unavailable' });
        expect(await resolve(other.id)).toEqual({ status: 'unavailable' });
        expect(await resolve(other.id, randomUUID())).toEqual({ status: 'unavailable' });
        await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date(1) } });
        expect(await resolve(owner.id)).toEqual({ status: 'tombstone' });
        expect(await resolve(other.id)).toEqual({ status: 'unavailable' });
        await db.machine.update({ where: { id: machine.id }, data: { revokedAt: null, replacedByMachineId: randomUUID() } });
        expect(await resolve(owner.id)).toEqual({ status: 'tombstone' });
        expect(await resolve(other.id)).toEqual({ status: 'unavailable' });
    });
});
