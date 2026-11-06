import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isMachineOnlineV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { serializeMachineHostFacts, serializeMachineRow } from '@/app/machines/machineSerialization';
import { buildNewMachineUpdate } from '@/app/events/eventPayloadBuilders';

describe('Home-owned Machine presence publication (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'machine-presence-negotiation-' }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('keeps Home-owned presence through host selection and new-Machine publication', async () => {
        const owner = await db.account.create({ data: {} });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: 'metadata', active: true, lastActiveAt: new Date(100_000) },
            include: { managedResource: { select: { id: true, homeId: true } } } });
        const access = { custodian: { accountId: owner.id, displayName: 'Owner' }, role: 'manage' as const,
            resourceMode: 'plain' as const, accessState: 'ready' as const };
        const host = serializeMachineHostFacts(machine, access);
        const published = buildNewMachineUpdate(machine, 1, randomUUID()).body;
        expect(published.t).toBe('new-machine');
        if (published.t !== 'new-machine') throw new Error('Expected new-Machine publication');
        for (const projection of [host, MachinePublishedRowV1Schema.parse({ ...published, id: machine.id })]) {
            expect(isMachineOnlineV1({ ...projection, active: projection.active === true }, 160_001)).toBe(true);
            expect(isMachineOnlineV1({ ...projection, active: false }, 100_001)).toBe(false);
        }
    });

    it('publishes Home-owned presence for legacy daemons', async () => {
        const owner = await db.account.create({ data: {} });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            installationId: 'presence-installation', metadata: 'metadata', active: true, lastActiveAt: new Date(100_000) } });
        const read = async () => MachinePublishedRowV1Schema.parse(serializeMachineRow(
            await db.machine.findUniqueOrThrow({ where: { id: machine.id },
                include: { managedResource: { select: { id: true, homeId: true } } } })));
        // The Home owns the timeout even when a 0.2 daemon cannot advertise capabilities.
        expect(isMachineOnlineV1({ ...await read(), active: true }, 160_001)).toBe(true);
        const admitted = await read();
        expect(isMachineOnlineV1({ ...admitted, active: true }, 1_000_000)).toBe(true);
        expect(isMachineOnlineV1({ ...admitted, active: false }, 100_001)).toBe(false);
    });
});
