import { createHash } from 'node:crypto';
import { DeploymentPublishInputV1Schema, type DeploymentPublishInputV1 } from '@happier-dev/protocol';
import { createDeploymentReceiptArtifactHeaderV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1, createDeploymentV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createWorkflowAccountRunActionOwner, materializeWorkflowAcceptedSnapshotV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
  ActionIdSchema, getActionSpec, type WorkflowRunStateV1, type ActionExecutorContext,
  computeActionInputApprovalDigestV1, WorkflowApprovedOperationV1Schema } from '@happier-dev/protocol';
import { prepareWorkflowApprovedOperationSnapshot } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { DurableWorkflowCoordinatorStore } from '@/daemon/workflows/production';
import { workflowInvocationKey } from '@/daemon/workflows/coordinator';
import { buildPublishWorkflow } from './publishProject';

/** Opened Home/Artifact boundary facts shared by real Publish owner suites. */
export function createPreparedPublishTestFixture(options: Readonly<{
  serverId?: string;
  accountId?: string;
  hostMachineId?: string;
  controllerMachineId?: string;
  buildMachineId?: string;
  projectSourceId?: string;
  sourceRevision?: number;
  environmentId?: string;
  environmentRevision?: number;
  targetLinkId?: string;
  targetLinkRevision?: number;
  artifactId?: string;
  artifactHeaderVersion?: number;
  artifactBodyVersion?: number;
  machines?: Extract<DeploymentPublishInputV1['destination'], { kind: 'ownServer' }>['machines'];
  setup?: DeploymentPublishInputV1['preparedChildren']['setup'];
}> = {}) {
  const serverId = options.serverId ?? 'deployment-home';
  const accountId = options.accountId ?? 'deployment-account';
  const hostMachineId = options.hostMachineId ?? 'parent-host';
  const controllerMachineId = options.controllerMachineId ?? 'environment-controller';
  const buildMachineId = options.buildMachineId ?? 'builder';
  const projectSourceId = options.projectSourceId ?? 'source-app';
  const sourceRevision = options.sourceRevision ?? 1;
  const environmentId = options.environmentId ?? 'staging';
  const environmentRevision = options.environmentRevision ?? 1;
  const targetLinkId = options.targetLinkId ?? 'runtime-link';
  const targetLinkRevision = options.targetLinkRevision ?? 1;
  const machines = options.machines ?? [{ machineId: 'runtime', installationId: 'installed' }];
  const document = 'services:\n  app:\n    image: example/app:1\n';
  const definition = { kind: 'stored' as const, contentRevision: 1,
    composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}` };
  const artifactRef = { contentArtifactId: options.artifactId ?? 'private-content',
    contentHeaderVersion: options.artifactHeaderVersion ?? 1, contentBodyVersion: options.artifactBodyVersion ?? 1 };
  const input = DeploymentPublishInputV1Schema.parse({ serverId, requestKey: 'publish-reviewed', hostMachineId,
    project: { kind: 'existing', projectSourceId, sourceRevision }, definition,
    destination: { kind: 'ownServer', machines, controllerMachineId, buildMachineId },
    environment: { kind: 'existing', environmentId, expectedRevision: environmentRevision },
    preparedChildren: { ...(options.setup ? { setup: options.setup } : {}),
      deploy: { serverId, environmentId, expectedRevision: environmentRevision, targetLinkId,
        expectedTargetLinkRevision: targetLinkRevision, requestKey: 'deploy-reviewed', ...artifactRef } },
  });
  const environment = createDeploymentEnvironmentHeaderV1({ serverId, id: environmentId, revision: environmentRevision, projectSourceId,
    controllerMachineId, buildMachineId, runtimeTargetLinkId: targetLinkId });
  const runtime = createDeploymentTargetLinkHeaderV1({ id: targetLinkId, environmentId, revision: targetLinkRevision,
    machines: machines.map(machine => machine.machineId), members: machines.map(machine => ({ ...machine, state: 'active' as const })) });
  const receipt = createDeploymentV1();
  if (receipt.content.t !== 'plain') throw new Error('plain_fixture_required');
  const sourceIntent = { ...definition, document, profiles: [], services: ['app'] };
  const content = { ...receipt.content.v, sourceIntent, machines: machines.map(machine => machine.machineId),
    machineResults: [], buildMachineId, ownServer: { approvedInputBasis: {
      v: 1 as const, environmentId: environment.id, environmentRevision: environment.revision,
      targetLinkId: runtime.id, targetLinkRevision: runtime.revision, sourceIntent, members: machines,
      bindings: [], images: receipt.content.v.images, manifestFingerprint: 'native-model', configInputDigests: [],
      physicalProjectName: 'staging-app', toolVersion: '2.0', services: ['app'], profiles: [],
    } } };
  return { input, source: { id: projectSourceId, revision: sourceRevision, name: 'Stored app', audience: [], createdByAccountId: accountId },
    environment, targetLinks: [runtime], artifact: { artifactId: artifactRef.contentArtifactId,
      header: createDeploymentReceiptArtifactHeaderV1('Stored app', content), body: JSON.stringify(content),
      revision: { headerVersion: artifactRef.contentHeaderVersion, bodyVersion: artifactRef.contentBodyVersion } } };
}

/** Real Run admission/content readers over the canonical opaque storage boundary fake. */
export async function createPublishWorkflowRecoveryFixture(input: DeploymentPublishInputV1, runId: string,
  state: WorkflowRunStateV1 = 'interrupted') {
  const accountId = 'deployment-account', machineId = 'parent-host', rootId = 'publish-root';
  const definition = buildPublishWorkflow(input);
  const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
    context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId, directory: '/publish', checkoutRootPath: '/publish' } },
      origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
      readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))) } });
  if (!accepted.ok) throw new Error(accepted.error.code);
  const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
    serverId: input.serverId, runtimeAccountId: accountId, actionRequestId: 'publish-request',
    approvedActionReplay: { artifactId: 'publish-approval' }, presentUserApproval: { artifactId: 'publish-approval',
      actionId: 'deployments.publish', requestId: 'publish-request', decidingAccountId: accountId,
      inputDigest: computeActionInputApprovalDigestV1('deployments.publish', input) },
    operationAcceptance: { actionId: 'deployments.publish', operationId: 'publish-operation', accept: () => {} } };
  const steps = definition.blocks.flatMap(block => block.kind === 'action' ? [{ blockId: block.id,
    actionId: block.actionId, input: Object.fromEntries(Object.entries(block.input).map(([name, field]) => {
      if (field.kind !== 'literal') throw new Error('publish_fixture_requires_concrete_inputs');
      return [name, field.value];
    })) }] : []);
  const snapshot = await prepareWorkflowApprovedOperationSnapshot({ snapshot: accepted.snapshot,
    parent: { actionId: 'deployments.publish', input: WorkflowApprovedOperationV1Schema.shape.parent.shape.input.parse(input) },
    steps: steps.map(({ actionId, input }) => ({ actionId, input })), context });
  const storage = createWorkflowRunStorageTestkit({ accountId, runId, machineId, origin: { kind: 'direct' },
    invocationPageSize: 1, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: snapshot })) });
  const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: rootId,
    nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } };
  await storage.execute({ operation: 'initialize', runId, expectedRevision: 0,
    checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint })),
    rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root', attempt: '0',
        invocationPath: { blockId: '$root', scope: [] }, logicalInvocationRecordId: rootId } })) } });
  const witness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
  const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
    rootRecordId: rootId, checkpoint, encryption: { witness, runCrypto: { mode: 'plain' } }, storage,
    revision: storage.run().revision });
  const lifecycle = state === 'succeeded' ? 'completed' : state === 'cancelled' ? 'cancelled'
    : state === 'interrupted' ? 'needs_attention' : state === 'running' ? 'running' : 'failed';
  const operationRefs = steps.map(({ blockId }) => ({ serverId: input.serverId,
    machineId: input.destination.controllerMachineId, operationId: `${blockId}-operation` }));
  for (const [index, step] of steps.entries()) {
    const key = workflowInvocationKey({ runId, blockId: step.blockId, scope: [], attempt: 0 });
    await store.ensureIntent({ key, recordId: `publish-${step.blockId}`, runId, blockId: step.blockId, memberOrdinal: String(index),
      parentKey: workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 }),
      path: { blockId: step.blockId, scope: [] }, blockKind: 'action', attempt: 0, acceptedAtMs: Date.now(), lifecycle: 'pending' });
    await store.commitFact({ key, lifecycle: 'running', execution: { kind: 'action', localInputId: `${step.blockId}-local`,
      actionId: step.actionId, actionRequestId: `${step.blockId}-reviewed`, input: step.input,
      awaitedOperations: [{ key: step.blockId, ...operationRefs[index]! }] } });
    await store.commitFact({ key, lifecycle: state === 'interrupted' ? 'completed' : lifecycle });
  }
  await store.commitFact({ key: workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 }), lifecycle });
  await storage.execute({ operation: 'transition', runId, expectedRevision: storage.run().revision,
    state, checkpointEnvelope: storage.checkpointEnvelope() });
  const reader = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => accountId, storage,
    definitions: { get: async () => { throw new Error('inline_run_has_no_saved_definition'); } },
    resolveEncryption: async () => ({ kind: 'available', witness }), normalizeAbsolutePath: directory => directory,
    randomBytes: () => { throw new Error('plain_account_has_no_keys'); } });
  const rootIds = [rootId];
  if (state === 'interrupted') {
    // Exercise real root recovery: the replacement root inherits a completed
    // child whose operation stays under the prior physical root.
    const recoveryContext = { ...context, callerPermissionMode: 'yolo' as const };
    const detail = WorkflowActionOutputSchemasV1['workflow.run.invocations.get'].parse(await reader.execute({
      actionId: 'workflow.run.invocations.get', input: { runId, invocationId: rootId }, context: recoveryContext }));
    const retry = detail.invocation.recoveryAvailability?.retry;
    if (retry?.kind !== 'available') throw new Error('publish_fixture_root_retry_unavailable');
    const recovered = WorkflowActionOutputSchemasV1['workflow.run.invocations.retry'].parse(await reader.execute({
      actionId: 'workflow.run.invocations.retry', input: { runId, invocation: { recordId: rootId },
        expectedRevision: storage.run().revision, causalInvocationIds: retry.causalInvocationIds,
        conversation: 'fresh_agent', input: { kind: 'original' } }, context: recoveryContext }));
    rootIds.push(recovered.invocation.id);
    const opened = WorkflowActionOutputSchemasV1['workflow.run.get'].parse(await reader.execute({
      actionId: 'workflow.run.get', input: { runId, includeUsage: false }, context: recoveryContext }));
    if (!opened.checkpoint) throw new Error('publish_fixture_recovery_checkpoint_required');
    const current = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
      rootRecordId: recovered.invocation.id, checkpoint: opened.checkpoint, encryption: { witness, runCrypto: { mode: 'plain' } },
      storage, revision: storage.run().revision });
    await current.commitFact({ key: workflowInvocationKey({ runId, blockId: '$root', scope: [],
      attempt: Number(recovered.invocation.attempt) }), lifecycle: 'needs_attention' });
    await storage.execute({ operation: 'transition', runId, expectedRevision: storage.run().revision,
      state, checkpointEnvelope: storage.checkpointEnvelope() });
  }
  return { reader, context, operationRef: operationRefs.at(-1)!, operationRefs, storage, rootIds };
}
