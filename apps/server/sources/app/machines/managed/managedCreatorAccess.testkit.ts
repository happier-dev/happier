import { admitManagedControl } from './managedMutations';
import { cancelManagedCreation, getManagedMachine, listManagedMachines } from './managedRead';
import { resolveEffectiveMachineRoleInTx } from '@/app/machines/machineAccess';
import { inTx } from '@/storage/inTx';
import { expect } from 'vitest';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import tweetnacl from 'tweetnacl';
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

export async function exerciseManagedCreatorAccess() {
    const { homeId, custodian, creator, stranger, controller, row, create } = await createCreatorFixture();
    const unrelated = await create(stranger.id);
    const legacy = await create();
    const target = { homeId, managedId: row.id };
    expect(await inTx(tx => resolveEffectiveMachineRoleInTx(tx, { actorAccountId: creator.id, machineId: controller.id }))).toBeNull();
    expect(await getManagedMachine({ actorAccountId: creator.id, input: target })).toMatchObject({ id: row.id });
    expect((await listManagedMachines({ actorAccountId: creator.id, input: { homeId } })).machines.map(machine => machine.id)).toEqual([row.id]);
    for (const managedId of [unrelated.id, legacy.id]) {
        await expect(getManagedMachine({ actorAccountId: creator.id, input: { homeId, managedId } })).rejects.toMatchObject({ code: 'permission_denied' });
        await expect(cancelManagedCreation({ actorAccountId: creator.id, input: { homeId, managedId, expectedIntentRevision: 0 } })).rejects.toMatchObject({ code: 'permission_denied' });
    }
    const controls = [
        { action: 'machines.managed.power.set', requestId: randomUUID(), input: { ...target, when: 'now', intent: 'start', expectedRevision: 0 } },
        { action: 'machines.managed.delete', requestId: randomUUID(), input: { ...target, when: 'now', intent: 'delete', expectedRevision: 0, reviewedDependencies: true } },
    ] as const;
    for (const input of controls) await expect(admitManagedControl({ actorAccountId: creator.id,
        custodianAccountId: custodian.id, input })).rejects.toMatchObject({ code: 'permission_denied' });
    expect(await cancelManagedCreation({ actorAccountId: creator.id, input: { ...target, expectedIntentRevision: 0 } }))
        .toMatchObject({ machine: { id: row.id, creationState: 'canceled', desired: 'delete' } });
    expect(await getManagedMachine({ actorAccountId: custodian.id, input: target })).toMatchObject({ id: row.id });
    await db.managedMachine.update({ where: { id: row.id }, data: { archivedAt: new Date() } });
    expect((await listManagedMachines({ actorAccountId: creator.id, input: { homeId, archived: true } })).machines.map(machine => machine.id)).toEqual([row.id]);
}

export async function exerciseManagedCreatorControllerProjection() {
    const { homeId, creator, custodian, controller, launch, row } = await createCreatorFixture();
    const installationPublicKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
    await db.machine.update({ where: { id: controller.id }, data: { installationPublicKey: new Uint8Array(installationPublicKey) } });
    const credentials = [{ purpose: { consumer: launch.provider, purpose: 'native' },
        account: { service: { pluginId: launch.provider.pluginId, localId: 'native-account' }, accountId: 'private-company-connection' } }];
    await db.managedMachine.update({ where: { id: row.id }, data: { launch: { ...launch, credentials },
        bootstrapCredentialRef: { kind: 'shared_resource', resourceId: 'private-bootstrap' } } });
    const input = { homeId, managedId: row.id };
    const visible = await getManagedMachine({ actorAccountId: creator.id, input });
    expect(visible.controllerAccess).toEqual({ installationPublicKey: encodeBase64(installationPublicKey, 'base64url'),
        custodian: { accountId: custodian.id } });
    expect(visible.launch).not.toHaveProperty('credentials');
    expect(visible).not.toHaveProperty('bootstrapCredentialRef');
    const listed = (await listManagedMachines({ actorAccountId: creator.id, input: { homeId } })).machines.find(machine => machine.id === row.id);
    expect(listed?.launch).not.toHaveProperty('credentials');
    expect(listed).not.toHaveProperty('bootstrapCredentialRef');
    const own = await getManagedMachine({ actorAccountId: custodian.id, input });
    expect(own.launch.credentials).toEqual(credentials);
    expect(own.bootstrapCredentialRef).toEqual({ kind: 'shared_resource', resourceId: 'private-bootstrap' });
    expect((await listManagedMachines({ actorAccountId: custodian.id, input: { homeId } })).machines.find(machine => machine.id === row.id)?.launch.credentials)
        .toEqual(credentials);
    const canceled = await cancelManagedCreation({ actorAccountId: creator.id, input: { ...input, expectedIntentRevision: 0 } });
    expect(canceled.machine.launch).not.toHaveProperty('credentials');
    expect(canceled.machine).not.toHaveProperty('bootstrapCredentialRef');
    const repeated = await cancelManagedCreation({ actorAccountId: creator.id, input: { ...input, expectedIntentRevision: canceled.machine.intentRevision } });
    expect(repeated.machine.launch).not.toHaveProperty('credentials');
    expect(repeated.machine).not.toHaveProperty('bootstrapCredentialRef');
    await db.machine.update({ where: { id: controller.id }, data: { revokedAt: new Date() } });
    expect(await getManagedMachine({ actorAccountId: creator.id, input })).not.toHaveProperty('controllerAccess');
}
