import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import nacl from 'tweetnacl';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, AutomationDefinitionCreateRequestSchema, computeDeploymentTransitionRequestDigestV1,
    encodePlainArtifactStoredContent, type DeploymentTransitionInputV1 } from '@happier-dev/protocol';
import { matchActionAutomationCompletionV1 } from '@happier-dev/protocol/actions/executor/actionAutomationCompletion';
import { AutomationEventAdmitInputV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentContentV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptContentV1';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { type BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { createDeploymentReceiptEventSourceAdapter, deploymentEvents } from '../../../../../packages/plugins/machine-services/src/deploymentEvents';
import { projectDeploymentReceiptInvalidationsForHost } from '../../../../cli/src/deployments/receiptEventInvalidation';
import { settleInterruptedDeploymentReceiptForHost } from '../../../../cli/src/deployments/receiptRecovery';
import { admitAutomationActionOccurrencesV1 } from '@/app/automations/automationActionAdmissionService';
import { createAutomation } from '@/app/automations/automationCrudService';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { readTransactionDatabaseTime } from '@/storage/transactionDatabaseTime';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { readDeploymentEnvironmentInTx, readDeploymentReceiptInTx } from './deploymentReadService';
import { createDeploymentInTx, projectDeploymentReceiptHeader, requestCancelDeploymentInTx, transitionDeploymentInTx } from './deploymentService';

describe('After Deploy Receipt recovery (real database)', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'deployment-receipt-completion-', initEncrypt: true });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('waits for reviewed cancellation to settle and emits each genuine outcome once', async () => {
        const serverId = await getOrCreateServerIdentityId();
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const accountId = account.id;
        const keys = nacl.sign.keyPair();
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        await db.machine.create({ data: { id: controller.machineId, accountId, installationId: controller.installationId,
            installationPublicKey: new Uint8Array(keys.publicKey), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const source = await inTx(tx => createProjectSourceInTx(tx, accountId, { serverId, requestKey: randomUUID(),
            name: 'Interrupted deploy', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const content = DeploymentContentV1Schema.parse({ sourceIntent: { kind: 'stored', contentRevision: 1,
            composeDigest: `sha256:${'a'.repeat(64)}`, document: 'services: {}', profiles: [], services: [] },
            machines: [controller.machineId], buildMachineId: controller.machineId, onFailure: 'keepPartial',
            images: [], machineResults: [], steps: [] });
        const artifact = async (kind: string) => {
            const result = await createArtifact({ actorUserId: accountId, artifactId: randomUUID(), kind: `v1:other:${kind}`,
                header: decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Interrupted deploy' })),
                body: decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(content) })),
                dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!result.ok) throw new Error(result.error);
            return { contentArtifactId: result.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: accountId, controllerMachineId: controller.machineId, buildMachineId: controller.machineId,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            ...await artifact('deployment-environment.v1') } });
        const environmentId = environment.id;
        const link = await db.deploymentTargetLink.create({ data: { environmentId, createdByAccountId: accountId,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
            machines: { create: [{ ...controller, position: 0, state: 'active' }] },
            ...await artifact('deployment-target-link.v1') } });
        await db.deploymentEnvironment.update({ where: { id: environmentId }, data: { runtimeTargetLinkId: link.id } });
        const createRunningReceipt = async (requestedAt = 10) => projectDeploymentReceiptHeader(await db.deployment.create({ data: { environmentId,
            targetLinkId: link.id, operation: 'deploy', state: 'running', revision: 2, requestKey: randomUUID(),
            requestedByAccountId: accountId, actionOperationId: randomUUID(), requestedAt: new Date(requestedAt), startedAt: new Date(requestedAt + 1),
            acceptedControllerMachineId: controller.machineId, acceptedControllerInstallationId: controller.installationId,
            ...await artifact('deployment-receipt.v1') } }));
        const running = await createRunningReceipt();
        let transitionTime = 0;
        const settle = (receipt: typeof running, expectedRevision: number, state: 'outcome_unknown' | 'failed' | 'cancelled') => {
            const body = { serverId, environmentId, deploymentId: receipt.id, actionOperationId: receipt.actionOperationId,
                ...controller, expectedRevision, kind: 'settle', state } satisfies Omit<DeploymentTransitionInputV1, 'proof'>;
            return inTx(async tx => {
                const result = await transitionDeploymentInTx(tx, accountId, { ...body,
                    proof: signMachineInstallationProof({ payload: { version: 1, ...controller, accountId,
                        deploymentTransition: { serverId, environmentId, deploymentId: receipt.id, actionOperationId: receipt.actionOperationId,
                            expectedRevision, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: keys.secretKey }) });
                transitionTime = (await readTransactionDatabaseTime(tx)).getTime();
                return result;
            });
        };

        const subject = { kind: 'environment' as const, serverId, environmentId };
        const workflow = await createAutomation({ accountId, input: AutomationDefinitionCreateRequestSchema.parse({
            automationId: randomUUID(), name: 'After deploy', enabled: true, workflowDefinitionId: 'builtin:review-and-converge',
            executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, placement: 'action_invocation',
                workflow: { t: 'plain', v: { executionTarget: { kind: 'session' } } } },
            assignments: [], triggers: [{ triggerId: randomUUID(), trigger: { kind: 'action', phase: 'after', enabled: true,
                actionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1], subject } }],
        }) });
        const trigger = workflow.triggers[0]!;
        const triggers = [{ automationId: workflow.id, triggerId: trigger.id, triggerRevision: trigger.revision }];
        const admitted: Array<{ outcome: string | undefined; kind: string; occurredAt: number }> = [];
        const execute = async (actionId: string, input: unknown) => {
            if (actionId === 'deployments.receipts.get') {
                return inTx(tx => readDeploymentReceiptInTx(tx, accountId, input as Parameters<typeof readDeploymentReceiptInTx>[2]));
            }
            if (actionId === 'deployments.environments.get') {
                return inTx(tx => readDeploymentEnvironmentInTx(tx, accountId, input as Parameters<typeof readDeploymentEnvironmentInTx>[2]));
            }
            expect(actionId).toBe('automation.event.admit');
            const observation = AutomationEventAdmitInputV1Schema.parse(input);
            const declaration = deploymentEvents[observation.eventRef.localId]?.declaration.automation;
            if (!declaration || !observation.sourceInstanceId) throw new Error('Expected canonical Deploy Event');
            expect(observation.definitions).toEqual([]);
            const [evidence] = matchActionAutomationCompletionV1({ observation: { ...observation,
                sourceInstanceId: observation.sourceInstanceId, machineId: controller.machineId }, declaration,
                trigger: { kind: 'action', phase: 'after', actionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1], subject },
            });
            if (!evidence) throw new Error('Expected a native After Deploy occurrence');
            const { results } = await admitAutomationActionOccurrencesV1({ accountId, input: { evidence, triggers } });
            admitted.push({ outcome: evidence.outcome, kind: results[0]!.kind, occurredAt: evidence.occurredAt });
            return { results: [] };
        };

        let receive: ((event: unknown) => Promise<void>) | undefined;
        // Host Actions and delivery are the plugin boundaries. Their admitted Home services and event payloads are real.
        const context = { signal: new AbortController().signal, services: { actions: { execute }, events: { host: {
            subscribe(target: { eventId: string }, listener: (event: unknown) => Promise<void>) {
                if (target.eventId === '@happier/deployment/receipt-invalidated') receive = listener;
                return { dispose() {} };
            },
        } } } } as unknown as BackgroundServiceContext;
        const adapter = createDeploymentReceiptEventSourceAdapter(context.services.events.host, Date.now, context);
        const subscription = adapter.subscribeWake?.(async () => {});
        const wake = vi.spyOn(eventRouter, 'emitUpdate');
        type AccountWake = Extract<Parameters<typeof projectDeploymentReceiptInvalidationsForHost>[0], { t: 'account-change' }>;
        const takeReceiptWake = (): AccountWake => {
            const bodies = wake.mock.calls.splice(0).flatMap(([update]) => update.userId === accountId
                && update.payload.body.t === 'account-change' ? [update.payload.body] : []);
            const body = bodies.find(candidate => candidate.entityIds?.some(id => id.startsWith('deployment-receipt:')));
            if (!body) throw new Error('Receipt wake missing after committed transition');
            return body;
        };
        const deliver = async (body: AccountWake) => {
            if (!receive) throw new Error('Receipt listener missing');
            for (const event of await projectDeploymentReceiptInvalidationsForHost(body, async () => serverId)) await receive(event);
        };
        try {
            const cancelling = await createRunningReceipt();
            expect(await inTx(tx => requestCancelDeploymentInTx(tx, accountId, {
                serverId, environmentId, deploymentId: cancelling.id, expectedReceiptRevision: cancelling.revision,
            }))).toMatchObject({ ok: true, deploymentRevision: 3, state: 'outcome_unknown' });
            expect(await db.deployment.findUniqueOrThrow({ where: { id: cancelling.id } })).toMatchObject({
                cancelRequestedAt: expect.any(Date), settledAt: null,
            });
            const pendingWake = takeReceiptWake();
            await deliver(pendingWake);
            expect.soft(await db.automationRun.count({ where: { automationId: workflow.id } })).toBe(0);

            expect(await settle(cancelling, 3, 'cancelled')).toMatchObject({ ok: true, deploymentRevision: 4, state: 'cancelled' });
            const cancelled = await db.deployment.findUniqueOrThrow({ where: { id: cancelling.id } });
            const cancelledWake = takeReceiptWake();
            await deliver(cancelledWake);
            await deliver(pendingWake);
            await deliver(cancelledWake);
            expect.soft(admitted.splice(0)).toEqual([
                { kind: 'admitted', outcome: 'cancelled', occurredAt: cancelled.settledAt?.getTime() },
                { kind: 'rejoined', outcome: 'cancelled', occurredAt: cancelled.settledAt?.getTime() },
            ]);
            const runsBeforeControls = await db.automationRun.count({ where: { automationId: workflow.id } });
            expect.soft(runsBeforeControls).toBe(1);

            const exact = await createRunningReceipt();
            expect(await settle(exact, 2, 'cancelled')).toMatchObject({ ok: true, deploymentRevision: 3, state: 'cancelled' });
            const exactWake = takeReceiptWake();
            const exactCancelled = await db.deployment.findUniqueOrThrow({ where: { id: exact.id } });
            await deliver(exactWake);
            await deliver(exactWake);
            expect(admitted.splice(0)).toEqual([
                { kind: 'admitted', outcome: 'cancelled', occurredAt: exactCancelled.settledAt?.getTime() },
                { kind: 'rejoined', outcome: 'cancelled', occurredAt: exactCancelled.settledAt?.getTime() },
            ]);
            expect(await db.automationRun.count({ where: { automationId: workflow.id } })).toBe(runsBeforeControls + 1);

            expect(await settleInterruptedDeploymentReceiptForHost({ ...controller, accountId, environmentId,
                context: {}, requestKey: randomUUID(), operation: 'deploy' }, {
                readInProgress: async () => [running], readOperation: async () => null, readReceipt: async () => ({ content }),
                writeTransition: async request => {
                    expect(request).toMatchObject({ expectedRevision: 2, state: 'outcome_unknown' });
                    const result = await settle(running, request.expectedRevision, 'outcome_unknown');
                    if (!result.ok || !('deploymentId' in result)) throw new Error(JSON.stringify(result));
                    return result;
                },
            })).toBeNull();
            const unknownWake = takeReceiptWake();
            const unknown = await db.deployment.findUniqueOrThrow({ where: { id: running.id } });
            expect(unknown).toMatchObject({ revision: 3, state: 'outcome_unknown', settledAt: null, cancelRequestedAt: null });
            const rollbackInput = { serverId, environmentId, targetLinkId: link.id, expectedRevision: environment.revision,
                expectedTargetLinkRevision: link.revision, deploymentId: unknown.id, requestKey: randomUUID(),
                actionOperationId: randomUUID(), ...await artifact('deployment-receipt.v1') };
            expect(await inTx(tx => createDeploymentInTx(tx, accountId, rollbackInput, 'rollback')))
                .toMatchObject({ ok: false, error: 'deployment_conflict' });
            const retained = await createRunningReceipt(1);
            await db.deployment.update({ where: { id: retained.id }, data: { state: 'succeeded', settledAt: new Date(3) } });
            expect(await inTx(tx => createDeploymentInTx(tx, accountId, { ...rollbackInput, deploymentId: retained.id }, 'rollback')))
                .toMatchObject({ ok: true, state: 'queued' });
            takeReceiptWake();
            await deliver(unknownWake);
            expect(admitted).toEqual([{ kind: 'admitted', outcome: 'outcome_unknown', occurredAt: transitionTime }]);
            const occurredAt = admitted[0]!.occurredAt;
            expect(await settle(running, 3, 'failed')).toMatchObject({ ok: true, deploymentRevision: 4, state: 'failed' });
            const failed = await db.deployment.findUniqueOrThrow({ where: { id: running.id } });
            const failedWake = takeReceiptWake();
            await deliver(failedWake);
            await deliver(unknownWake);
            await deliver(failedWake);
            expect.soft(admitted.splice(1)).toEqual([
                { kind: 'admitted', outcome: 'failed', occurredAt: failed.settledAt?.getTime() },
                { kind: 'rejoined', outcome: 'outcome_unknown', occurredAt },
                { kind: 'rejoined', outcome: 'failed', occurredAt: failed.settledAt?.getTime() },
            ]);
            const runsBeforeDirectFailure = await db.automationRun.count({ where: { automationId: workflow.id } });
            expect.soft(runsBeforeDirectFailure).toBe(runsBeforeControls + 3);

            const direct = await createRunningReceipt();
            expect(await settle(direct, 2, 'failed')).toMatchObject({ ok: true, deploymentRevision: 3, state: 'failed' });
            await deliver(takeReceiptWake());
            const settled = await db.deployment.findUniqueOrThrow({ where: { id: direct.id } });
            expect(admitted[1]).toEqual({ kind: 'admitted', outcome: 'failed', occurredAt: settled.settledAt?.getTime() });
            expect(await db.automationRun.count({ where: { automationId: workflow.id } })).toBe(runsBeforeDirectFailure + 1);
        } finally {
            subscription?.dispose();
            wake.mockRestore();
        }
    });
});
