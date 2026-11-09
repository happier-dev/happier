import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { db } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { materializeWorkflowAcceptedSnapshotFixture } from '@/testkit/workflowAcceptedSnapshot';
import { registerWorkflowRunStorageRoutes } from './registerWorkflowRunStorageRoutes';
import { registerManagedMachineRoutes } from '@/app/machines/managed/managedRoutes';

/** Real HTTP admission and exact lookup, shared by disposable SQLite and PostgreSQL. */
export async function exerciseManagedWorkflowBirth(options: Readonly<{
    measureLookup?: (read: () => Promise<void>) => Promise<void>;
}> = {}) {
    const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const outsider = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const controller = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: randomUUID(), metadata: '{}' } });
    const guest = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: randomUUID(), metadata: '{}' } });
    const homeId = await getOrCreateServerIdentityId();
    const managed = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
        controllerMachineId: controller.id, controllerInstallationId: controller.installationId!,
        admittedActionRequestId: randomUUID(), admittedInput: {}, launch: {}, retention: {}, wakeOnAcceptedMessage: false,
        allocation: 'bound', enrolledMachineId: guest.id } });
    const managedCreation = { homeId, managedId: managed.id,
        controller: { machineId: controller.id, installationId: controller.installationId! } };
    const runId = randomUUID();
    const acceptedSnapshot = await materializeWorkflowAcceptedSnapshotFixture({
        definition: { version: 1, inputs: [], defaults: {}, blocks: [
            { kind: 'wait', id: 'answer', document: { text: 'Answer', references: [], attachments: [] }, result: { kind: 'text' } },
        ] },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: guest.id, executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: guest.id, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: account.id, runId }, acceptedSnapshot }));
    const body = { operation: 'admit', publisherMachineId: guest.id, runId, origin: { kind: 'direct' }, machineId: guest.id,
        accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, acceptedEnvelope, managedCreation };
    await withAuthenticatedTestApp(app => {
        registerManagedMachineRoutes(app);
        registerWorkflowRunStorageRoutes(app, {
        // Signed publisher verification is the credential boundary; all admission/storage logic is real.
        verifyPublisher: async () => ({ machineId: guest.id, installationId: guest.installationId!,
            requestNonce: randomUUID(), proofExpiresAt: new Date(Date.now() + 60_000) }),
        });
    }, async app => {
        const headers = { 'x-test-user-id': account.id };
        const post = (payload: unknown, actor = account.id) => app.inject({ method: 'POST',
            url: '/v3/automations/runs/workflow-storage', headers: { ...headers, 'x-test-user-id': actor }, payload });
        const created = await post(body);
        expect(created.statusCode, created.body).toBe(200);
        expect(created.json()).toMatchObject({ kind: 'created', run: { id: runId } });
        expect((await post(body)).json()).toMatchObject({ kind: 'existing', run: { id: runId } });
        const changed = await post({ ...body, managedCreation: { ...managedCreation, managedId: randomUUID() } });
        expect(changed.statusCode).toBe(409);
        const unauthorized = await post({ ...body, runId: randomUUID() }, outsider.id);
        expect(unauthorized.statusCode).toBe(403);
        expect(await db.automationRun.count({ where: { accountId: outsider.id } })).toBe(0);
        const ordinaryRunId = randomUUID();
        const ordinary = await post({ ...body, managedCreation: undefined, runId: ordinaryRunId,
            acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'accepted_snapshot', accountId: account.id, runId: ordinaryRunId }, acceptedSnapshot })) });
        expect(ordinary.statusCode, ordinary.body).toBe(200);
        expect((await db.automationRun.findUniqueOrThrow({ where: { id: ordinaryRunId } })).managedCreationId).toBeNull();
        const foreignHome = await post({ ...body, runId: randomUUID(), managedCreation: { ...managedCreation, homeId: randomUUID() } });
        expect(foreignHome.statusCode).toBe(403);
        await db.managedMachine.update({ where: { id: managed.id }, data: { enrolledMachineId: controller.id } });
        expect((await post({ ...body, runId: randomUUID() })).statusCode).toBe(403);
        await db.managedMachine.update({ where: { id: managed.id }, data: { enrolledMachineId: guest.id } });
        await db.managedMachine.update({ where: { id: managed.id }, data: { controllerInstallationId: randomUUID() } });
        expect((await post(body)).json()).toMatchObject({ kind: 'existing', run: { id: runId } });
        const refused = await post({ ...body, runId: randomUUID() });
        expect(refused.statusCode).toBe(403);
        await db.session.createMany({ data: Array.from({ length: 1_000 }, () => ({
            accountId: account.id, tag: randomUUID(), metadata: 'unrelated private Session',
        })) });
        await db.automationRun.createMany({ data: Array.from({ length: 1_000 }, () => ({
            accountId: account.id, originKind: 'direct', causeKind: null, state: 'succeeded', scheduledAt: new Date(), dueAt: new Date(),
            workflowAcceptedSnapshotEnvelope: 'unrelated private Run', workflowCustodyState: 'settled',
        })) });
        // A Session born on the same Machine never overrides the workflow birth.
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
            metadata: 'private birth Session', managedCreationId: managed.id } });
        const lookup = (actor = account.id, home = homeId) => app.inject({ method: 'POST',
            url: '/v1/machines/managed/actions/birth.get', headers: { 'x-test-user-id': actor },
            payload: { homeId: home, managedId: managed.id } });
        const checkLookup = async () => {
            const found = await lookup();
            expect(found.statusCode, found.body).toBe(200);
            expect(found.json()).toEqual({ source: { kind: 'run', source: { kind: 'workflow_run', runId } } });
        };
        if (options.measureLookup) await options.measureLookup(checkLookup);
        else await checkLookup();
        expect((await lookup(outsider.id)).json()).toEqual({ source: null });
        expect((await lookup(account.id, randomUUID())).json()).toEqual({ source: null });
        const privateField = await app.inject({ method: 'POST', url: '/v1/machines/managed/actions/birth.get',
            headers, payload: { homeId, managedId: managed.id, title: 'private' } });
        expect(privateField.statusCode).toBe(400);
        // A historical null relationship is never backfilled by admission retry.
        await db.automationRun.update({ where: { id: runId }, data: { managedCreationId: null } });
        expect((await lookup()).json()).toEqual({ source: { kind: 'session', sessionId: session.id } });
        expect((await post(body)).statusCode).toBe(409);
        await db.automationRun.update({ where: { id: runId }, data: { managedCreationId: managed.id } });
        await db.managedMachine.update({ where: { id: managed.id }, data: { controllerInstallationId: managedCreation.controller.installationId } });
        const duplicateRunId = randomUUID();
        const duplicate = await post({ ...body, runId: duplicateRunId,
            acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'accepted_snapshot', accountId: account.id, runId: duplicateRunId }, acceptedSnapshot })) });
        expect(duplicate.statusCode, duplicate.body).toBe(200);
        expect((await lookup()).json()).toEqual({ source: { kind: 'session', sessionId: session.id } });
    });
    await db.automationRun.deleteMany({ where: { accountId: account.id } });
    await db.session.deleteMany({ where: { accountId: account.id } });
    await db.managedMachine.delete({ where: { id: managed.id } });
    await db.machine.deleteMany({ where: { accountId: account.id } });
    await db.account.deleteMany({ where: { id: { in: [account.id, outsider.id] } } });
}
