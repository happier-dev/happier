import { expect, it } from 'vitest';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { prepareWorkflowApprovedOperationSnapshot } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1,
    sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { verifyExternalActionMachineRpcExecution } from '@/app/auth/externalActionExecutionAuthorization';
import { claimAutomationRun } from '@/app/automations/automationClaimService';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createDiscussion } from '@/app/discussions/mutations';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createWorkflowApprovedOperationReader } from '../../../../../../cli/src/daemon/workflows/workflowApprovedOperation';
import { createCredentialedWorkflowRunEncryptionResolver } from '../../../../../../cli/src/daemon/workflows/workflowActionAdmission';
import { createWorkflowRunStorageClient } from '../../../../../../cli/src/daemon/workflows/workflowRunStorageClient';
import { resolveWorkflowDiscussionOrigin } from '../../../../../../cli/src/daemon/workflows/workflowDiscussion';
import { createDiscussionActionDeps } from '../../../../../../cli/src/discussions/discussionActionDeps';
import { signPluginInstallationPublisherHeader, type CreatePluginInstallationPublisherHeader } from '../../../../../../cli/src/plugins/installations/publisherProof';
import { registerWorkflowRunStorageRoutes } from '../automations/registerWorkflowRunStorageRoutes';
import { createReviewedChildAuthorizationFixture } from './reviewedChildAuthorization.composed.testkit';

/** Registered against real database providers; every authority carrier comes from its production producer. */
export function registerWorkflowChildAuthorizationCharacterization(): void {
    it('reopens an admitted Workflow operation before issuing its exact Setup Plan RPC and rejects a freshly signed foreign target', async () => {
        const f = await createReviewedChildAuthorizationFixture();
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        registerWorkflowRunStorageRoutes(app);
        const storageOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
        try {
            const serverId = await getOrCreateServerIdentityId();
            const sources = [{ kind: 'direct', setup: {} }];
            const parentInput = getActionSpec('machines.setup.apply').inputSchema.parse({ homeId: serverId,
                machineId: f.machine.id, targets: [{ homeId: serverId, machineId: f.machine.id,
                    desiredRevision: 0, recipePlans: [], sources }] });
            const parent = { actionId: 'machines.setup.apply' as const, input: parentInput };
            const issued = await f.root(parent.actionId, parent.input);
            const authorization = await f.withAccountProjection(issued);
            const child = { actionId: 'machines.setup.plan' as const,
                input: getActionSpec('machines.setup.plan').inputSchema.parse({ homeId: serverId,
                    machineId: f.machine.id, sources, mode: 'effects' }) };
            const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: { version: 1,
                blocks: [{ kind: 'action', id: 'plan', actionId: child.actionId,
                    input: Object.fromEntries(Object.entries(child.input).map(([field, value]) => [field, { kind: 'literal', value }])) }] },
                context: { source: { kind: 'inline' }, inputs: {}, machineId: f.machine.id,
                    executionTarget: { kind: 'session' }, workspaceTarget: { project: {
                        machineId: f.machine.id, directory: '/repo', checkoutRootPath: '/repo' } },
                    origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' },
                        externalActionExecutionAuthorization: { v: authorization.v, token: authorization.token,
                            binding: authorization.binding } } }, admission: { kind: 'user' }, effects: {
                    // Machine availability is the external boundary; Action declarations retain their production owner.
                    resolveTargetAvailability: async () => true,
                    readActionContract: async id => freezeWorkflowActionContractV1(
                        actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))),
                } });
            if (!materialized.ok) throw new Error(`workflow_materialization_failed:${JSON.stringify(materialized.error)}`);
            const snapshot = materialized.snapshot;
            const accepted = await prepareWorkflowApprovedOperationSnapshot({ snapshot, parent, steps: [child],
                context: { ...f.context(authorization), authority: 'present_user', actionCaller: { kind: 'host' },
                    actionRequestId: authorization.binding.requestId } });
            const runId = crypto.randomUUID();
            const rootId = crypto.randomUUID();
            const invocationId = crypto.randomUUID();
            const actionRequestId = `${runId}/${invocationId}/0`;
            const stored = (envelope: Parameters<typeof serializeWorkflowStoredContentEnvelopeV1>[0]) =>
                serializeWorkflowStoredContentEnvelopeV1(envelope);
            const checkpoint = (nextSequence: string) => stored(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'checkpoint', accountId: f.account.id, runId },
                checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence,
                    frontier: { nextBlockOrdinal: 0, paused: false } } }));
            const progress = (root: boolean, admitting = false) => stored(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'invocation_progress', accountId: f.account.id, runId,
                    recordId: root ? rootId : invocationId, sequence: root ? '0' : '1',
                    parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
                progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'action',
                    invocationPath: { blockId: root ? '$root' : 'plan', scope: [] }, attempt: '0',
                    logicalInvocationRecordId: root ? rootId : invocationId,
                    ...(admitting ? { execution: { kind: 'action', ...child, actionRequestId, localInputId: crypto.randomUUID() } } : {}) } }));
            const storage = createWorkflowRunStorageClient({ token: f.presentUserToken, machineId: f.machine.id,
                serverHttpBaseUrl: storageOrigin, createPublisherHeader: (request: Parameters<CreatePluginInstallationPublisherHeader>[0]) => signPluginInstallationPublisherHeader({ ...request,
                    machineId: f.machine.id, identity: { version: 1, installationId: f.machine.installationId!, createdAt: 1,
                        publicKey: Buffer.from(f.keyPair.publicKey).toString('base64url'),
                        privateKey: Buffer.from(f.keyPair.secretKey).toString('base64url') } }) });
            const currentnessResponse = await f.app.inject({ method: 'GET', url: '/v1/account/encryption/currentness',
                headers: { authorization: `Bearer ${f.presentUserToken}` } });
            expect(currentnessResponse.statusCode, currentnessResponse.body).toBe(200);
            const currentness = AccountEncryptionCurrentnessResponseSchema.parse(currentnessResponse.json());
            const accountCurrentness = { mode: currentness.mode, version: currentness.version,
                contentKeyFingerprint: currentness.contentKeyFingerprint };
            expect(await storage.execute({ operation: 'admit', runId, origin: { kind: 'direct' }, machineId: f.machine.id,
                accountCurrentness, acceptedEnvelope: stored(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                    binding: { v: 1, purpose: 'accepted_snapshot', accountId: f.account.id, runId }, acceptedSnapshot: accepted })) }))
                .toMatchObject({ run: { id: runId, state: 'queued', workflowCustodyState: 'pending' } });
            const claimed = await claimAutomationRun({ accountId: f.account.id, machineId: f.machine.id,
                leaseDurationMs: 30_000, scope: 'workflow', recipeFeaturePolicy: { workflowsEnabled: true } });
            expect(claimed.run).toMatchObject({ id: runId });
            if (!claimed.run) throw new Error('workflow_claim_required');
            const initialized = await storage.execute({ operation: 'initialize', runId, parentAttempt: claimed.run.attempt,
                expectedRevision: claimed.run.revision, accountCurrentness, checkpointEnvelope: checkpoint('1'),
                rootInvocation: { id: rootId, contentEnvelope: progress(true) } });
            expect(initialized).toMatchObject({ initialization: 'created' });
            const run = await storage.execute({ operation: 'get', runId });
            const revision = typeof run === 'object' && run !== null && 'run' in run
                && typeof run.run === 'object' && run.run !== null && 'revision' in run.run ? run.run.revision : undefined;
            if (typeof revision !== 'number') throw new Error('workflow_run_revision_required');
            await storage.execute({ operation: 'invocations.admit', runId, parentAttempt: claimed.run.attempt,
                expectedRevision: revision, accountCurrentness, checkpointEnvelope: checkpoint('2'),
                invocations: [{ id: invocationId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', contentEnvelope: progress(false) }] });
            await storage.execute({ operation: 'invocations.fact', runId, parentAttempt: claimed.run.attempt,
                accountCurrentness, invocationId, invocationAttempt: '0', expectedContentRevision: '0',
                expectedLifecycle: 'pending', lifecycle: 'admitting', contentEnvelope: progress(false, true) });
            const context: ActionExecutorContext = { ...f.context(authorization), surface: 'cli', actionRequestId,
                executionRunWorkflowRunId: runId, actionCaller: { kind: 'workflowRun', runId, authorization: accepted.authorization } };
            const reader = createWorkflowApprovedOperationReader({ storage,
                resolveEncryption: createCredentialedWorkflowRunEncryptionResolver({
                    credentials: { token: f.presentUserToken, encryption: null }, serverHttpBaseUrl: f.origin }) });
            const admission = await reader({ runId, actionId: child.actionId, input: child.input, context, phase: 'dispatch' });
            expect(admission?.invokeReviewedChild, 'real accepted Run and exact admitting invocation must produce the private issuer').toBeTypeOf('function');
            if (!admission?.invokeReviewedChild) throw new Error('workflow_reviewed_child_issuer_required');
            const result = await admission.invokeReviewedChild(async childContext => {
                const verify = async (machineId: string) => {
                    const packet = f.rpc(childContext, child.actionId, `${machineId}:${RPC_METHODS.MACHINE_SETUP_PLAN}`, child.input);
                    expect(packet.execution.reviewedChild).toMatchObject({ actionId: child.actionId, role: invocationId });
                    return verifyExternalActionMachineRpcExecution(packet.execution, { ...packet.request,
                        originalActionEnvelope: { v: 1, requestId: authorization.binding.requestId,
                            target: authorization.binding.target, input: parent.input } });
                };
                expect(await verify(f.machine.id)).toMatchObject({ binding: { actionId: parent.actionId }, effectActionId: child.actionId });
                // Re-sign the different destination through the same production packet producer.
                expect(await verify(crypto.randomUUID())).toBeNull();
                return { ok: true, result: null };
            });
            expect(result).toEqual({ ok: true, result: null });
            expect(await reader({ runId, actionId: child.actionId, input: { ...child.input, sources: [] },
                context, phase: 'dispatch' })).toBeNull();
        } finally { await app.close(); await f.app.close(); }
    });

    it('opens a committed Workflow question through real signed preparation HTTP and refuses a freshly signed foreign Account read', async () => {
        const f = await createReviewedChildAuthorizationFixture();
        const foreign = await createReviewedChildAuthorizationFixture();
        try {
            const question = async (accountId: string) => {
                const created = await createDiscussion({ actorAccountId: accountId,
                    authentication: createPresentUserSessionAccessAuthentication(), request: {
                        creationLocalId: crypto.randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Workflow question' } },
                        firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain', v: { v: 1,
                            parts: [{ t: 'text', text: 'Review this committed question' }] } }, mentionedAccountIds: [] },
                    } });
                if (!created.ok) throw new Error(created.error);
                return created.value;
            };
            const own = await question(f.account.id);
            const other = await question(foreign.account.id);
            const serverId = await getOrCreateServerIdentityId();
            const origin = { kind: 'discussion' as const, discussion: { serverId, discussionId: own.discussion.id },
                addressingMessageId: own.firstMessage.id };
            const input = getActionSpec('workflow.run.start').inputSchema.parse({ runId: crypto.randomUUID(),
                source: { kind: 'inline', definition: { version: 1, blocks: ['work'] } }, origin });
            const authorization = await f.withAccountProjection(await f.root('workflow.run.start', input));
            const context: ActionExecutorContext = { ...f.context(authorization), serverIdentityId: serverId };
            const discussionAction = createDiscussionActionDeps({ credentials: { token: f.presentUserToken, encryption: null },
                serverId, serverIdentityId: serverId, serverHttpBaseUrl: f.origin,
                externalActionMachineRequestPrivateKey: f.keyPair.secretKey,
                externalActionMachineInstallationId: f.machine.installationId! }).discussionAction!;
            // This production preparation occurs before a Run exists and retains the root context rather than issuing a reviewed child.
            expect(await resolveWorkflowDiscussionOrigin({ origin, context, discussionAction })).toEqual({
                discussion: origin.discussion, messageId: own.firstMessage.id, throughSeq: own.firstMessage.seq });
            const denied = await discussionAction({ actionId: 'discussion.read', context,
                input: { discussionId: other.discussion.id, messageId: other.firstMessage.id } });
            expect(denied).toMatchObject({ ok: false });
            expect(f.currentnessRequests).toEqual(expect.arrayContaining([
                expect.objectContaining({ method: 'GET', path: `/v1/discussions/${other.discussion.id}`, status: 404 }),
            ]));
        } finally { await foreign.app.close(); await f.app.close(); }
    });
}
