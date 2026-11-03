import { randomUUID } from 'node:crypto';
import { db } from '@/storage/db';

export async function createCreatorFixture() {
    const homeId = `srv_${'a'.repeat(32)}`;
    const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
    const creator = await db.account.create({ data: { encryptionMode: 'plain' } });
    const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
    const controller = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
        metadata: '{}', installationId: randomUUID() } });
    const launch = { provider: { pluginId: 'fixture.creator', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
    const presetId = randomUUID();
    const create = (enrollmentAccountId?: string) => db.managedMachine.create({ data: {
        homeId, custodianAccountId: custodian.id, controllerMachineId: controller.id,
        controllerInstallationId: controller.installationId!, admittedActionRequestId: randomUUID(),
        admittedInput: enrollmentAccountId ? { enrollmentAccountId } : {}, presetId, presetRevision: 1,
        launch, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    } });
    const row = await create(creator.id);
    return { homeId, custodian, creator, stranger, controller, launch, row, create };
}
