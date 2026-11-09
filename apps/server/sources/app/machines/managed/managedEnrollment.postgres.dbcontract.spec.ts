import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { requireManagedMachineRegistrationInTx } from './managedMutations';
import { readMachineDevcontainerWorkspaceSyncRouteInTx } from './managedRows';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('managed enrollment Account replacement guard', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run only through the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it('routes only the exact requester-owned workspace to its controller through current and pending replacement enrollment', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1,
            metadata: '{}', installationId: randomUUID() } });
        const guest = await db.machine.create({ data: { id: randomUUID(), accountId: requester.id,
            metadata: '{}', installationId: randomUUID() } });
        const otherController = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            metadata: '{}', installationId: randomUUID() } });
        const otherGuest = await db.machine.create({ data: { id: randomUUID(), accountId: requester.id,
            metadata: '{}', installationId: randomUUID() } });
        const row = await db.managedMachine.create({ data: {
            homeId, custodianAccountId: custodian.id, controllerMachineId: controller.id,
            controllerInstallationId: controller.installationId!, enrolledMachineId: guest.id,
            admittedActionRequestId: randomUUID(), admittedInput: { enrollmentAccountId: requester.id },
            launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
                value: {}, devcontainerObservation: { nativeResourceId: 'old-native', user: 'coder', workspaceFolder: '/work',
                    storage: { kind: 'bind', hostPath: '/host/work', childPath: '/work' } } },
        } });
        const input = { accountServerId: homeId, childMachineId: guest.id, childRootPath: '/work',
            operation: { actorAccountId: requester.id, callerAuthority: 'present_user' as const, rpcMethod: 'daemon.workspaceSync.handoffSourcePhase.v1' },
            parentMachineId: controller.id, releaseOnly: false };
        const expected = { custodianAccountId: custodian.id, parentMachineId: controller.id,
            parentInstallationId: controller.installationId };
        const route = (overrides: Partial<typeof input> = {}) => inTx(tx => readMachineDevcontainerWorkspaceSyncRouteInTx(tx, { ...input, ...overrides }));
        expect(await route()).toEqual(expected);
        expect(await route({ releaseOnly: true })).toEqual(expected);
        for (const overrides of [{ childMachineId: otherGuest.id }, { parentMachineId: otherController.id },
            { childRootPath: '/other' }, { accountServerId: `srv_${'b'.repeat(32)}` }]) expect(await route(overrides)).toBeNull();
        // Existing rebuild custody retains only the old enrollment correlation;
        // its current resource/root may already describe the new native guest.
        await db.managedMachine.update({ where: { id: row.id }, data: { enrolledMachineId: null,
            admittedInput: { enrollmentAccountId: requester.id, replacementEnrollment: { machineId: guest.id } },
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
                value: {}, devcontainerObservation: { nativeResourceId: 'new-native', user: 'coder', workspaceFolder: '/new',
                    storage: { kind: 'child', childPath: '/new' } } } } });
        expect(await route()).toBeNull();
        expect(await route({ releaseOnly: true })).toEqual(expected);
        for (const overrides of [{ childMachineId: otherGuest.id }, { parentMachineId: otherController.id },
            { accountServerId: `srv_${'b'.repeat(32)}` }]) expect(await route({ ...overrides, releaseOnly: true })).toBeNull();
        await db.managedMachine.update({ where: { id: row.id }, data: { admittedInput: {
            enrollmentAccountId: custodian.id, replacementEnrollment: { machineId: guest.id } } } });
        expect(await route({ releaseOnly: true })).toBeNull();
        await db.managedMachine.update({ where: { id: row.id }, data: { admittedInput: {
            enrollmentAccountId: requester.id, replacementEnrollment: { machineId: guest.id } }, controllerInstallationId: 'retired-installation' } });
        expect(await route({ releaseOnly: true })).toBeNull();
    });

    it('finds requester-owned pending replacement proof independently of controller custody', async () => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guestId = randomUUID();
        const row = await db.managedMachine.create({ data: {
            homeId: await getOrCreateServerIdentityId(), custodianAccountId: custodian.id,
            controllerMachineId: randomUUID(), controllerInstallationId: randomUUID(),
            admittedActionRequestId: randomUUID(), admittedInput: { enrollmentAccountId: requester.id,
                replacementEnrollment: { machineId: guestId } },
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        } });
        for (const accountId of [requester.id, custodian.id]) {
            await expect(inTx(tx => requireManagedMachineRegistrationInTx(tx, { accountId, machineId: guestId })))
                .rejects.toMatchObject({ code: 'enrollment_retired' });
        }
        // Historical absence still recognizes the custodian's retained proof requirement.
        await db.managedMachine.update({ where: { id: row.id }, data: {
            admittedInput: { replacementEnrollment: { machineId: guestId } },
        } });
        await expect(inTx(tx => requireManagedMachineRegistrationInTx(tx, { accountId: custodian.id, machineId: guestId })))
            .rejects.toMatchObject({ code: 'enrollment_retired' });
        await db.managedMachine.update({ where: { id: row.id }, data: { creationState: 'canceled' } });
        await expect(inTx(tx => requireManagedMachineRegistrationInTx(tx, { accountId: requester.id, machineId: guestId })))
            .resolves.toBeUndefined();
    });
});
