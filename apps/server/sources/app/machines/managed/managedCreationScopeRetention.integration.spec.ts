import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectManagedMachine, readManagedAdmissionState } from './managedRows';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { transitionSessionArchiveStateInTx } from '@/app/session/archive/transitionSessionArchiveStateInTx';
import { bindManagedCreationScopeRetentionInTx, validateManagedCreationBirthInTx } from './managedCreationBirth';
import { cancelWorkflowRun } from '@/app/workflows/workflowRunService';
import { reportManagedIntent } from './managedMutations';
import { classifyLayout1SessionCreateThrow } from '@/app/session/create/createFreshBoundLayout1Session';

describe('creation scope retention at the real archive owner', () => {
    let harness: LightSqliteHarness;
    const homeId = 'srv_creation_scope_retention';
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-scope-retention-',
        env: { HAPPIER_SERVER_IDENTITY_ID: homeId } }); }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('admits bound local birth only on its controller and reserves the guest until that Session is archived', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(), metadata: '{}' } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: owner.id,
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId,
            admittedActionRequestId: randomUUID(), admittedInput: { enrollmentAccountId: owner.id, acquisitionMode: 'resource-bound' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Local guest', choices: {} },
            resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            allocation: 'bound', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const birth = { homeId, managedId: row.id, controller: { machineId: controller.id, installationId: controller.installationId! } };
        const admit = (accountId = owner.id, executionMachineId = controller.id) =>
            inTx(tx => validateManagedCreationBirthInTx(tx, { accountId, birth, executionMachineId }));
        expect(await admit()).not.toBe(false);
        expect(await admit(other.id)).toBe(false);
        expect(await admit(owner.id, 'another-machine')).toBe(false);
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}',
            encryptionMode: 'plain', managedCreationId: row.id } });
        await expect(admit()).rejects.toMatchObject({ name: 'ManagedCreationBusyError' });
        await db.session.update({ where: { id: session.id }, data: { archivedAt: new Date() } });
        expect(await admit()).not.toBe(false);
        const concurrent = await Promise.allSettled([1, 2].map(() => inTx(async tx => {
            const admitted = await validateManagedCreationBirthInTx(tx, { accountId: owner.id, birth, executionMachineId: controller.id });
            if (!admitted) throw new Error('Expected local admission');
            return tx.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}',
                encryptionMode: 'plain', managedCreationId: row.id } });
        })));
        expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(concurrent.filter(result => result.status === 'rejected').map(result => result.reason))
            .toEqual([expect.objectContaining({ name: 'ManagedCreationBusyError' })]);
        const rejected = concurrent.find(result => result.status === 'rejected');
        if (rejected?.status !== 'rejected') throw new Error('Expected competing birth refusal');
        expect(classifyLayout1SessionCreateThrow(rejected.reason)).toEqual({ reason: 'session-managed-target-busy' });
        expect(await db.session.count({ where: { managedCreationId: row.id, archivedAt: null } })).toBe(1);
        await db.session.updateMany({ where: { managedCreationId: row.id }, data: { archivedAt: new Date() } });
        await db.managedMachine.update({ where: { id: row.id }, data: { admittedInput: { enrollmentAccountId: owner.id } } });
        expect(await admit()).toBe(false);
    });

    it('admits a Can-use member\'s bound birth on the custodian\'s controller and refuses everyone else', async () => {
        // Machine-policy and explicit Session-preset acquisitions keep the controller's Account as custodian
        // and record the member as the admitted requester; the member's Session is that guest's birth.
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(), metadata: '{}' } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: owner.id,
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId,
            admittedActionRequestId: randomUUID(), admittedInput: { enrollmentAccountId: member.id, acquisitionMode: 'resource-bound' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Member guest', choices: {} },
            resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            allocation: 'bound', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const birth = { homeId, managedId: row.id, controller: { machineId: controller.id, installationId: controller.installationId! } };
        const admit = (accountId: string, executionMachineId?: string) =>
            inTx(tx => validateManagedCreationBirthInTx(tx, { accountId, birth, ...(executionMachineId ? { executionMachineId } : {}) }));
        expect(await admit(member.id)).not.toBe(false);
        expect(await admit(member.id, controller.id)).not.toBe(false);
        expect(await admit(member.id, 'another-machine')).toBe(false);
        expect(await admit(owner.id)).toBe(false);
        expect(await admit(other.id)).toBe(false);
    });

    it('binds only the admitted creator choice and cannot attach Delete to a Keep acquisition', async () => {
        const creator = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            installationId: randomUUID(), metadata: '{}' } });
        const guest = await db.machine.create({ data: { id: randomUUID(), accountId: creator.id, metadata: '{}' } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.id,
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId!, enrolledMachineId: guest.id,
            admittedActionRequestId: randomUUID(), admittedInput: { enrollmentAccountId: creator.id },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', creationState: 'active', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const birth = { homeId, managedId: row.id, controller: { machineId: controller.id, installationId: controller.installationId! } };
        const source = { kind: 'session' as const, sessionId: randomUUID() };
        await inTx(async tx => {
            const admitted = await validateManagedCreationBirthInTx(tx, { accountId: creator.id, birth, executionMachineId: guest.id });
            expect(admitted).not.toBe(false);
            if (!admitted) throw new Error('Expected admitted birth');
            await bindManagedCreationScopeRetentionInTx(tx, admitted, source);
        });
        expect(projectManagedMachine(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } }))).not.toHaveProperty('creationScopeRetention');
        await db.managedMachine.update({ where: { id: row.id }, data: { admittedInput: {
            enrollmentAccountId: creator.id, creationScopeRetention: { effect: 'stop' },
        } } });
        await inTx(async tx => {
            expect(await validateManagedCreationBirthInTx(tx, { accountId: custodian.id, birth, executionMachineId: guest.id })).toBe(false);
            expect(await validateManagedCreationBirthInTx(tx, { accountId: creator.id, birth, executionMachineId: controller.id })).toBe(false);
            const admitted = await validateManagedCreationBirthInTx(tx, { accountId: creator.id, birth, executionMachineId: guest.id });
            if (!admitted) throw new Error('Expected admitted creator birth');
            await bindManagedCreationScopeRetentionInTx(tx, admitted, source);
        });
        expect(projectManagedMachine(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).creationScopeRetention)
            .toEqual({ effect: 'stop', source });
    });

    it('selects the retained Delete effect through the actual workflow Run terminal entry', async () => {
        const creator = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await db.machine.create({ data: { id: randomUUID(), accountId: creator.id, metadata: '{}' } });
        const runId = randomUUID();
        const source = { kind: 'run' as const, source: { kind: 'workflow_run' as const, runId } };
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.id,
            enrolledMachineId: guest.id, admittedActionRequestId: randomUUID(),
            admittedInput: { enrollmentAccountId: creator.id, creationScopeRetention: { effect: 'delete', source } },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', creationState: 'active', desired: 'stop', retention: { kind: 'until-delete' },
            resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            wakeOnAcceptedMessage: false } });
        await db.automationRun.create({ data: { id: runId, accountId: creator.id, originKind: 'direct', causeKind: null,
            state: 'queued', scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: 'pending',
            // Cancellation does not open private accepted program content.
            workflowAcceptedSnapshotEnvelope: 'unopened retained accepted program', managedCreationId: row.id,
            assignments: { create: { machineId: guest.id, priority: 0 } } } });
        expect(projectManagedMachine(row).retention).toEqual({ kind: 'until-delete' });
        const result = await cancelWorkflowRun({ accountId: creator.id, runId, expectedRevision: 0 });
        expect(result.run.state).toBe('cancelled');
        const ended = await db.automationRun.findUniqueOrThrow({ where: { id: runId } });
        expect(ended.finishedAt).not.toBeNull();
        expect(projectManagedMachine(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } }))).toMatchObject({
            desired: 'stop', retention: { kind: 'unused', afterMs: 0, effect: 'delete' },
            creationScopeRetention: { effect: 'delete', source, endedAt: ended.finishedAt!.getTime() },
        });
        expect(await db.automation.count({ where: { accountId: creator.id } })).toBe(0);
    });

    it.each([0, 12345])('consumes only the admitted shared-controller birth into idle Delete after %s ms', async afterMs => {
        const creator = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sourceId = randomUUID();
        const scope = { effect: 'delete', ...(afterMs ? { afterMs } : {}), source: { kind: 'session', sessionId: sourceId } };
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.id,
            admittedActionRequestId: randomUUID(), admittedInput: { enrollmentAccountId: creator.id, creationScopeRetention: scope },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1,
            resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const createSession = (id: string) => db.session.create({ data: { id, accountId: creator.id,
            managedCreationId: row.id, tag: id, metadata: '{}', agentState: null, encryptionMode: 'plain' } });
        const source = await createSession(sourceId);
        const unrelated = await createSession(randomUUID());
        const archivedAt = new Date();
        await inTx(tx => transitionSessionArchiveStateInTx({ tx, sessionId: unrelated.id, wasArchived: false, archivedAt }));
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).retention).toEqual({ kind: 'until-delete' });
        await inTx(tx => transitionSessionArchiveStateInTx({ tx, sessionId: source.id, wasArchived: false, archivedAt }));
        expect(projectManagedMachine(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } }))).toMatchObject({
            retention: { kind: 'unused', effect: 'delete', afterMs }, desired: 'stop',
            creationScopeRetention: { ...scope, endedAt: archivedAt.getTime() },
        });
        expect(await db.automation.count({ where: { accountId: creator.id } })).toBe(0);
    });

    it.each(['stop', 'delete'] as const)('reopening cancels the source-ended %s policy and preserves submitted native settlement', async effect => {
        const creator = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sourceId = randomUUID();
        const scope = { effect, source: { kind: 'session' as const, sessionId: sourceId } };
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: creator.id,
            admittedActionRequestId: randomUUID(), admittedInput: { enrollmentAccountId: creator.id, creationScopeRetention: scope },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', creationState: 'active', desired: 'start', intentRevision: 1,
            resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true } });
        await db.session.create({ data: { id: sourceId, accountId: creator.id, managedCreationId: row.id,
            tag: sourceId, metadata: '{}', encryptionMode: 'plain' } });
        const transition = (wasArchived: boolean, archivedAt: Date | null) => inTx(tx =>
            transitionSessionArchiveStateInTx({ tx, sessionId: sourceId, wasArchived, archivedAt }));
        await transition(false, new Date());
        const archived = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        expect(projectManagedMachine(archived).retention).toEqual({ kind: 'unused', afterMs: 0, effect });
        await transition(true, null);
        const reopened = projectManagedMachine(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } }));
        expect(reopened).toMatchObject({ retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
            creationScopeRetention: scope, intentRevision: archived.intentRevision + 1 });
        expect(reopened.creationScopeRetention).not.toHaveProperty('endedAt');

        await transition(false, new Date());
        const submittedFrom = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        const currentness = { homeId, managedId: row.id, expectedIntentRevision: submittedFrom.intentRevision,
            requestId: randomUUID() };
        const submitted = { ...currentness, intent: effect };
        await db.managedMachine.update({ where: { id: row.id }, data: { desired: effect,
            admittedInput: { ...readManagedAdmissionState(submittedFrom.admittedInput), submittedEffect: submitted } } });
        await transition(true, null);
        const pending = projectManagedMachine(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } }));
        expect(pending.submittedNativeEffect).toEqual({ intentRevision: submitted.expectedIntentRevision,
            requestId: submitted.requestId, intent: effect });
        expect(pending.creationScopeRetention).not.toHaveProperty('endedAt');
        const observation = effect === 'delete'
            ? { availability: 'absent' as const, storage: 'lost' as const, observedAt: Date.now() }
            : { availability: 'present' as const, power: 'stopped' as const, storage: 'retained' as const, observedAt: Date.now() };
        const settled = await reportManagedIntent({ ...currentness, result: { kind: 'confirmed' }, observation });
        expect(settled.machine.submittedNativeEffect).toBeUndefined();
        expect(settled.machine.retention).toEqual({ kind: 'until-delete' });
        expect(settled.machine.allocation).toBe(effect === 'delete' ? 'confirmed-absent' : 'bound');
    });
});
