import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionRequestEnvelopeSchema,
    ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { startWorkflowSharedMachineServer } from '@/testkit/workflowSharedMachineServer.testkit';
import { deriveMachineSetupCombinedRunIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { admitWorkflowRun } from '@/app/workflows/workflowRunService';
import { fetchAutomationAccountCurrentnessWitnessTx } from '@/app/automations/automationAccountCurrentness';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { setMachineAccessGrantInTx } from '@/app/machines/machineAccess';

let server: Awaited<ReturnType<typeof startWorkflowSharedMachineServer>>;
beforeAll(async () => { server = await startWorkflowSharedMachineServer(); }, 120_000);
afterAll(async () => { if (server) await server.close(); });

it('admits every reviewed target together, refusing mixed Manage and Use before a Run or native effect', async () => {
    const [controller, receiver] = server.machines;
    const actionId = 'machines.setup.updates.rollout';
    const input = { homeId: server.homeId, machineId: controller.id, failurePolicy: 'fail_stop',
        batches: [[controller, receiver].map(machine => ({ homeId: server.homeId, machineId: machine.id, scope: 'security',
            plan: { v: 1, basis: { kind: 'updates', machineId: machine.id, scope: 'security' },
                steps: [], nativeFacts: [], planDigest: 'a'.repeat(64) } }))] };
    const admit = async (token: string) => fetch(`${server.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, machineId: controller.id, envelope: ExternalActionRequestEnvelopeSchema.parse({
            v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId: controller.id }, input,
        }) }),
    });
    const before = await server.readEffects();
    const owner = await admit(server.token);
    expect(owner.status).toBe(200);
    const owned = ExternalActionExecutionAuthorizationV1Schema.parse(await owner.json());
    expect(owned.binding.deploymentPreparationAdmission).toEqual({ operation: 'setup',
        machineTargets: [controller.id, receiver.id], deployments: [] });
    expect((await admit(server.guest.token)).status).toBe(403);
    await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: server.accountId, machineId: controller.id,
        principal: { kind: 'account', accountId: server.guest.accountId }, level: 'admin' }));
    expect((await admit(server.guest.token)).status).toBe(403);
    expect(await server.readEffects()).toEqual(before);
    await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: server.accountId, machineId: receiver.id,
        principal: { kind: 'account', accountId: server.guest.accountId }, level: 'admin' }));
    const manager = await admit(server.guest.token);
    expect(manager.status).toBe(200);
    const managed = ExternalActionExecutionAuthorizationV1Schema.parse(await manager.json());
    expect(managed.binding.admittedMachineRole).toBe('manage');
    const principalAccountId = server.guest.accountId;
    const runId = deriveMachineSetupCombinedRunIdV1({ actionId: 'machines.setup.updates.rollout',
        homeId: server.homeId, accountId: principalAccountId, requestId: managed.binding.requestId });
    const accepted = await server.materialize({ version: 1, inputs: [], defaults: {}, blocks: [{
        kind: 'wait', id: 'review', document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' },
    }] }, controller.id);
    const accountCurrentness = await fetchAutomationAccountCurrentnessWitnessTx(db, principalAccountId);
    if (!accountCurrentness) throw new Error('Missing requester Account');
    await admitWorkflowRun({ accountId: principalAccountId, machineId: controller.id, runId, accountCurrentness,
        origin: { kind: 'direct' }, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(
            sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'accepted_snapshot', accountId: principalAccountId, runId }, acceptedSnapshot: accepted })) });
    await server.claimGuestRun(controller.id);
    await server.revokeGuest(receiver.id);
    expect((await admit(server.guest.token)).status).toBe(403);
    const childAction = 'machines.setup.updates.apply';
    const requestId = `${runId}/${randomUUID()}/0`;
    const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId,
        target: { kind: 'machine', machineId: receiver.id }, input: input.batches[0]![1] });
    const origin = { runId, requestId };
    const child = await fetch(`${server.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(childAction)}`, {
        method: 'POST', headers: { authorization: `Bearer ${server.guest.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, machineId: controller.id, envelope, workflowActionOrigin: origin,
            executionAuthorization: managed, installationProof: signMachineInstallationProof({ privateKey: controller.keys.secretKey,
                payload: { version: 1, accountId: principalAccountId, machineId: controller.id,
                    installationId: controller.installationId, externalActionOrigin: { homeId: server.homeId,
                        actionId: childAction, requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } }) }),
    });
    expect(child.status, await child.clone().text()).toBe(200);
    expect(ExternalActionExecutionAuthorizationV1Schema.parse(await child.json()).binding).toMatchObject({
        machineId: receiver.id, workflowActionOrigin: origin, admittedMachineRole: 'manage' });

});
