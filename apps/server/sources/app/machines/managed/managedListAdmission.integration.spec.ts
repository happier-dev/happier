import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as pluginJsonSchemaValidation from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { ManagedAdmissionInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { seedBundledManagedAvailability } from './managedProjectionVolume.testkit';
import { admitManagedAcquire } from './managedAcquire';
import { listManagedMachines } from './managedRead';

describe('managed list admission cost', () => {
    const homeId = `srv_${'a'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-list-admission-', initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: homeId } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('does not rebuild or run declared admission schemas while listing 128 retained allocations repeatedly', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: '{}',
            installationId: controller.installationId, pluginMaterializationRevision: 1n } });
        const manifest = await seedBundledManagedAvailability(account.id, homeId, controller, ['machine-lima.json']);
        const launch = { provider: { pluginId: manifest.id, localId: 'lima' }, schemaVersion: 1, name: 'Admitted guest',
            choices: { store: '/tmp/list-admission', image: 'fixture:ubuntu', arch: 'x86_64',
                vmType: 'qemu', cpus: 2, memoryGiB: 4, diskGiB: 16, mounts: [] } };
        const created = await admitManagedAcquire({ requesterAccountId: account.id, custodianAccountId: account.id,
            requestEnvelopeDigest: 'list-admission', input: ManagedAdmissionInputV1Schema.parse({ requestId: randomUUID(), continuationPresent: false,
                input: { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
                    selection: { kind: 'one-off', homeId, controller, launch,
                        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } } }) });
        const admitted = await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } });
        // OPEN-S0B's observed census is 128 allocations. Reuse the real ingress's
        // admitted JSON rather than inventing a second persisted admission shape.
        await db.managedMachine.createMany({ data: Array.from({ length: 127 }, () => ({
            homeId, custodianAccountId: account.id, controllerMachineId: controller.machineId,
            controllerInstallationId: controller.installationId, admittedActionRequestId: randomUUID(),
            admittedInput: admitted.admittedInput!, launch, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        })) });
        // Transparent instrumentation: all admission and schema logic remains real.
        const constructions = vi.spyOn(pluginJsonSchemaValidation, 'createPluginJsonSchemaZodValueAdapter');
        try {
            for (let read = 0; read < 3; read += 1) {
                const result = await listManagedMachines({ actorAccountId: account.id, input: { homeId } });
                expect(result.machines).toHaveLength(128);
                expect(result.machines.find(machine => machine.id === created.machine.id)?.launch).toEqual(launch);
                expect(constructions).toHaveBeenCalledTimes(0);
            }
            await db.managedMachine.update({ where: { id: created.machine.id }, data: { desired: 'stop', intentRevision: 1 } });
            const changed = await listManagedMachines({ actorAccountId: account.id, input: { homeId } });
            expect(changed.machines.find(machine => machine.id === created.machine.id)).toMatchObject({ desired: 'stop', intentRevision: 1 });
            expect(constructions).toHaveBeenCalledTimes(0);
        } finally { constructions.mockRestore(); }
    }, 120_000);

});
