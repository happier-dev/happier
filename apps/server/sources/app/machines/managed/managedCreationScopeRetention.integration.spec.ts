import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectManagedMachine } from './managedRows';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { transitionSessionArchiveStateInTx } from '@/app/session/archive/transitionSessionArchiveStateInTx';
import { bindManagedCreationScopeRetentionInTx, validateManagedCreationBirthInTx } from './managedCreationBirth';
import { cancelWorkflowRun } from '@/app/workflows/workflowRunService';

describe('creation scope retention at the real archive owner', () => {
    let harness: LightSqliteHarness;
    const homeId = 'srv_creation_scope_retention';
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-scope-retention-',
        env: { HAPPIER_SERVER_IDENTITY_ID: homeId } }); }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

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
});
