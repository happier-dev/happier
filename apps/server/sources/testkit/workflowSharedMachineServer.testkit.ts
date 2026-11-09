import { randomUUID } from 'node:crypto';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { setMachineAccessGrantInTx, removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { makeShareEligibleForTest } from './shareEligibility.testkit';
import { createSignedAccountContentBinding } from './accountEncryption';
import { automationAccountCurrentnessSelect, deriveAutomationAccountCurrentnessWitness } from '@/app/automations/automationAccountCurrentness';
import { claimAutomationRun } from '@/app/automations/automationClaimService';
import { materializeWorkflowAcceptedSnapshotFixture } from './workflowAcceptedSnapshot';
import { startWorkflowApprovedOperationServer } from './workflowApprovedOperationServer.testkit';

/** Existing real HTTP/auth/storage fixture, with the grant owned by Machine access. */
export async function startWorkflowSharedMachineServer(input: Readonly<{ contentPublicKey?: Uint8Array }> = {}) {
    const server = await startWorkflowApprovedOperationServer({ workflowSessions: true });
    try {
        const guest = await db.account.create({ data: input.contentPublicKey
            ? { ...createSignedAccountContentBinding(input.contentPublicKey), encryptionMode: 'e2ee' }
            : { encryptionMode: 'plain' } });
        const foreign = await server.createForeignAccount();
        await makeShareEligibleForTest(server.accountId, guest.id);
        for (const machine of server.machines) {
            const result = await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: server.accountId,
                machineId: machine.id, principal: { kind: 'account', accountId: guest.id }, level: 'view' }));
            if (result.kind !== 'saved') throw new Error('shared_workflow_fixture_grant_unavailable');
        }
        const currentness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({
            where: { id: guest.id }, select: automationAccountCurrentnessSelect }));
        return {
            ...server,
            custodianAccountId: server.accountId,
            guest: { accountId: guest.id, currentness,
                token: await auth.createToken(guest.id, undefined, { kind: 'account', authority: 'present_user' }) },
            foreign,
            materialize: (definition: WorkflowDefinitionV1, machineId: string) => materializeWorkflowAcceptedSnapshotFixture({
                definition,
                context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
                    workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                    origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
            }),
            claimGuestRun: async (machineId: string) => {
                const machine = server.machines.find(item => item.id === machineId);
                if (!machine) throw new Error('unknown_shared_workflow_machine');
                const result = await claimAutomationRun({ accountId: guest.id, machineId, scope: 'workflow',
                    leaseDurationMs: 30_000, recipeFeaturePolicy: { workflowsEnabled: true },
                    claimRequest: { machineInstallationId: machine.installationId, nonce: randomUUID(),
                        expiresAt: new Date(Date.now() + 60_000) } });
                if (!result.run) throw new Error('shared_workflow_fixture_claim_unavailable');
                return { runId: result.run.id, attempt: result.run.attempt, revision: result.run.revision };
            },
            revokeGuest: (machineId: string) => inTx(tx => removeMachineAccessGrantInTx(tx, {
                actorAccountId: server.accountId, machineId, principal: { kind: 'account', accountId: guest.id },
            })),
            readEffects: async () => ({
                runs: await db.automationRun.findMany({ select: { id: true, accountId: true, state: true, errorCode: true } }),
                sessions: await db.session.findMany({ select: { id: true, accountId: true } }),
                keyRecipients: await db.workflowRunDataKeyEnvelope.findMany({ select: { runId: true, recipientAccountId: true } }),
            }),
        };
    } catch (error) {
        await server.close();
        throw error;
    }
}
