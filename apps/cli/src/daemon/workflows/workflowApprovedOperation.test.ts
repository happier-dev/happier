import { describe, expect, it } from 'vitest';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { prepareWorkflowRunDataKeyV1, type WorkflowRunReadEncryptionV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { WorkflowAcceptedSnapshotV1Schema, type WorkflowApprovedOperationV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1, openWorkflowAcceptedSnapshotStoredEnvelopeV1, openWorkflowProgressStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { createPlainWorkflowRunKeyCensusFixture, createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import { createWorkflowApprovedOperationReader, prepareWorkflowApprovedOperationSnapshot } from './workflowApprovedOperation';
import { createAccountWorkflowTriggerActions } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import { prepareWorkflowApprovedOperation } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { AutomationDefinitionDetailSchema, AutomationRunCauseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { resolveActionApprovalRouting } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createActionExecutor, readHostReviewedChildOperationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { DeploymentDeployInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { WorkflowAuthoredResultReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1, AutomationTriggerIdSchema, AutomationSourceSelectorIdV1Schema, PluginJsonValueV2Schema } from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createPromptDocInLibrary, type PromptLibraryArtifactStore, type PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createActionExecutorBoundaryFixture } from '../../../../../packages/tests/src/testkit/actionExecutorBoundary';

const runId = '52bd37c4-99c6-41cf-90a5-3a1be2b1e031';
const invocationId = 'exact-child';
const accountId = 'owner';
const setupSources: JsonValue[] = [
  { kind: 'accountPreset', presetId: 'preset', presetRevision: 0, setup: { scripts: [{ body: 'echo reviewed', affects: 'none' }] } },
  { kind: 'direct', setup: {} },
];
const parent = { actionId: 'machines.setup.apply' as const,
  input: { homeId: 'home', machineId: 'host', targets: [{ homeId: 'home', machineId: 'host', desiredRevision: 0, recipePlans: [], sources: setupSources }] } };
const steps = [{ actionId: 'machines.setup.apply', input: { ...parent.input, machineId: 'target',
  targets: parent.input.targets.map(target => ({ ...target, machineId: 'target' })) } }];
const actionRequestId = `${runId}/${invocationId}/0`;
const definition = { version: 1, inputs: [], defaults: {}, blocks: [
  { kind: 'action', id: 'apply', actionId: 'machines.setup.apply', input: {} },
] };

function snapshot() {
  return WorkflowAcceptedSnapshotV1Schema.parse({ startedBy: 'user', authoredDefinition: definition, definition,
    materializedLeaves: [{ sourceKey: '$root', blockId: 'apply', kind: 'action', selection: {}, authoredWorkspace: { kind: 'inherit' },
      executionTarget: { kind: 'session' }, actionId: 'machines.setup.apply', actionInput: steps[0]!.input,
      actionContract: { inputSchema: { type: 'object' }, outputSchema: {} } }],
    frozenChildren: {}, workDepth: 0, metadata: null, inputs: {}, machineId: 'host', executionTarget: { kind: 'session' },
    workspaceTarget: { project: { machineId: 'host', directory: '/repo', checkoutRootPath: '/repo' } },
    source: { kind: 'inline' }, origin: { kind: 'direct', actionPolicy: { surface: 'ui', authority: 'present_user' } },
    authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } } });
}

function approvedContext(): ActionExecutorContext {
  return { actionRequestId: 'parent-request', approvedActionReplay: { artifactId: 'approval' },
    presentUserApproval: { artifactId: 'approval', actionId: parent.actionId, requestId: 'parent-request',
      inputDigest: computeActionInputApprovalDigestV1(parent.actionId, parent.input), decidingAccountId: accountId } };
}

async function fixture(withApproval = true, encrypted = false) {
  const approved = withApproval
    ? await prepareWorkflowApprovedOperationSnapshot({ snapshot: snapshot(), parent, steps, context: approvedContext() }) : snapshot();
  const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
    material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } });
  const accountEncryption = { kind: 'available' as const, witness: { mode: 'e2ee' as const, version: 1,
    contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) }, material };
  const randomBytes = (length: number) => new Uint8Array(length).fill(3);
  const preparedKey = encrypted ? prepareWorkflowRunDataKeyV1({ accountId, encryption: accountEncryption, randomBytes }) : null;
  const mode = preparedKey ? { ...preparedKey.runCrypto, randomBytes } : { mode: 'plain' as const };
  const keyCensus = createPlainWorkflowRunKeyCensusFixture({ runId, accountId });
  const encryption: WorkflowRunReadEncryptionV1 = encrypted ? accountEncryption : { witness: { mode: 'plain' } };
  const envelope = preparedKey?.recipientKeyEnvelopes[0]?.encryptedDataKey ?? null;
  const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
    ...mode, binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: approved }));
  const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'host', accountId,
    state: 'running', origin: { kind: 'direct' }, acceptedEnvelope,
    keyCensus: encrypted ? { ...keyCensus, encryptionMode: 'e2ee', ownerAccountCurrentness: accountEncryption.witness,
      dataEncryptionKey: envelope, callerDataEncryptionKey: envelope } : keyCensus });
  const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId,
    recordId: invocationId, sequence: '1', parentRecordId: 'root', memberOrdinal: '0', attempt: '0' };
  const progress = { kind: 'happier.workflow-progress.v1' as const, blockKind: 'action' as const,
    invocationPath: { blockId: 'apply', scope: [] }, attempt: '0', logicalInvocationRecordId: invocationId };
  const content = (execution?: { kind: 'action'; actionId: string; actionRequestId: string; localInputId: string; input: (typeof steps)[0]['input'] }) =>
    serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...mode, binding,
      progress: { ...progress, ...(execution ? { execution } : {}) } }));
  await storage.execute({ operation: 'invocations.admit', runId, parentAttempt: 0,
    expectedRevision: 0, checkpointEnvelope: '{}', invocations: [{ id: invocationId, sequence: '1', parentRecordId: 'root',
      memberOrdinal: '0', contentEnvelope: content() }] });
  const context: ActionExecutorContext = { actionRequestId, executionRunWorkflowRunId: runId, runtimeAccountId: accountId,
    actionCaller: { kind: 'workflowRun', runId, authorization: approved.authorization } };
  const reader = createWorkflowApprovedOperationReader({ storage,
    resolveEncryption: async () => encryption });
  const admit = async (input = steps[0]!.input) => storage.execute({ operation: 'invocations.fact', runId,
    invocationId, invocationAttempt: '0', expectedContentRevision: '0', expectedLifecycle: 'pending', lifecycle: 'admitting',
    contentEnvelope: content({ kind: 'action', actionId: steps[0]!.actionId, actionRequestId, localInputId: 'local', input }) });
  return { approved, storage, context, reader, admit, encryption, mode };
}

describe('Workflow approved operation private custody', () => {
  it('continues an exact reviewed child with demanded work and holds a changed child', async () => {
    const h = await fixture(false);
    const actionId = 'prompt_doc.create' as const;
    const input = { title: 'Reviewed document', markdown: 'Reviewed text', folderId: 'new-folder',
      createFolder: { id: 'new-folder', name: 'Reviewed folder', expectedRevision: 3 } };
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'action', id: 'apply', actionId,
        input: Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { kind: 'literal', value }])) },
    ] });
    const child = { actionId, input };
    const accepted = await prepareWorkflowApprovedOperationSnapshot({
      snapshot: WorkflowAcceptedSnapshotV1Schema.parse({ ...h.approved, definition, authoredDefinition: definition,
        materializedLeaves: [{ ...h.approved.materializedLeaves[0], actionId, actionInput: input }] }),
      parent, steps: [child], context: approvedContext() });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted }));
    // Run storage is the boundary; retain the real custody and exact-input reader.
    const reader = createWorkflowApprovedOperationReader({ storage: { execute: async (request, options) => {
      const result = await h.storage.execute(request, options);
      return request.operation === 'get' && result && typeof result === 'object' ? { ...result, acceptedEnvelope } : result;
    } }, resolveEncryption: async () => h.encryption });
    const context: ActionExecutorContext = { ...h.context, surface: 'agent', authority: 'account_automation',
      serverId: 'home', interactivePresentation: 'unavailable', actionsSettings: normalizeActionsSettingsV1({ v: 1,
        actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] },
          'artifact.folders.create': { approvalRequiredSurfaces: ['agent'] } } }) };
    const read = (candidate = input) => reader({ runId, actionId, input: candidate, semanticInput: candidate,
      context, phase: 'prepare' });
    const admission = await read();
    expect(await admission?.invokeReviewedChild?.(async issued =>
      readHostReviewedChildOperationV1(issued, actionId, input)?.parent)).toEqual(parent);
    // Persistence is the boundary; keep the real folder and document owners.
    let record: PromptLibraryRecordV1 = { key: 'folders', value: { v: 1, folders: [] } };
    let revision = 3;
    const artifacts = new Map<string, PromptLibraryStoredArtifact>();
    const organization: NonNullable<ActionExecutorDeps['artifactFolders']> = { serverId: 'home', assertCurrent: () => {},
      ...{ listArtifactHeaders: async () => ({ items: [...artifacts.values()].flatMap(artifact => artifact.header
        ? [{ artifactId: artifact.id, header: artifact.header, owned: true }] : []), coverage: 'complete' as const }) },
      readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ record, revision }], tombstones: [], diagnostics: [] } }),
      writeRecord: async request => {
        if (request.expectedRevision !== revision) return { status: 'conflict', revision };
        record = request.record; revision++;
        return { status: 'updated', revision, cursor: revision };
      },
      readArtifactHeader: async id => {
        const header = artifacts.get(id)?.header;
        return header ? { header, owned: true } : null;
      },
    };
    const store: PromptLibraryArtifactStore = { organization, read: async id => artifacts.get(id) ?? null,
      update: async () => { throw new Error('unexpected artifact update'); },
      create: async request => { artifacts.set('saved', { id: 'saved', ...request,
        revision: { headerVersion: 1, bodyVersion: 1 } }); return 'saved'; } };
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
      readApprovedOperation: request => request.runId ? reader({ ...request, runId: request.runId }) : Promise.resolve(null),
      artifactFolders: organization,
      promptDocCreate: ({ signal, ...request }) => {
        if ('starter' in request) throw new Error('Unexpected starter outside the reviewed manual document fixture');
        return createPromptDocInLibrary({ store, request, signal });
      },
    }));
    const prepared = await executor.prepare(actionId, input, context);
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ kind: 'ready' });
    const changed = { ...input, markdown: 'Outside reviewed plan' };
    expect(await read(changed)).toBeNull();
    expect(await executor.prepare(actionId, changed, context)).toMatchObject({ kind: 'settled',
      result: { ok: false, errorCode: 'action_interactive_review_required' } });
    expect(record.value).toMatchObject({ folders: [] });
    expect(artifacts.size).toBe(0);
    if (prepared.kind !== 'ready') throw new Error('Expected reviewed child admission');
    expect(await prepared.invocation.run()).toMatchObject({ ok: true, result: { artifactId: 'saved' } });
    expect(record.value).toMatchObject({ folders: [{ id: 'new-folder', name: 'Reviewed folder' }] });
    expect(artifacts.get('saved')?.body).toContain('Reviewed text');
  });

  it.each([false, true])('resolves reviewed producer operands from the same persisted Run (encrypted=%s)', async encrypted => {
    const h = await fixture(false, encrypted);
    const fixed = { serverId: 'home', expectedTargetLinkRevision: 1, requestKey: 'catalog-deploy',
      contentArtifactId: 'catalog-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const concrete = DeploymentDeployInputV1Schema.parse({ ...fixed, environmentId: 'created-environment', targetLinkId: 'created-target', expectedRevision: 2 });
    const preparedConcrete = DeploymentDeployInputV1Schema.parse({ ...concrete, contentArtifactId: 'prepared-catalog-content' });
    const references: Record<string, WorkflowAuthoredResultReference> = Object.fromEntries(['environmentId', 'targetLinkId', 'expectedRevision'].map(name => [name, {
      kind: 'result', producer: { blockId: 'instantiate', scope: { kind: 'current' } },
      path: [name === 'expectedRevision' ? 'revision' : name],
    } satisfies WorkflowAuthoredResultReference]));
    const deferred = { actionId: 'deployments.deploy', input: fixed, binding: { kind: 'producer_result' as const, references } };
    const childDefinition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'action', id: 'instantiate', actionId: 'deployments.templates.instantiate', input: {} },
      { kind: 'action', id: 'apply', actionId: 'deployments.deploy', input: {
        ...Object.fromEntries(Object.entries(fixed).map(([name, value]) => [name, { kind: 'literal', value }])), ...references,
      } },
    ] });
    const { actionInput: _actionInput, ...materialized } = h.approved.materializedLeaves[0]!;
    const accepted = await prepareWorkflowApprovedOperationSnapshot({
      snapshot: WorkflowAcceptedSnapshotV1Schema.parse({ ...h.approved, definition: childDefinition, authoredDefinition: childDefinition,
        materializedLeaves: [{ ...materialized, actionId: 'deployments.deploy' }] }),
      parent, steps: [deferred], context: approvedContext(),
    });
    const operation = accepted.approvedOperation!;
    expect(operation.steps[0]?.binding).toEqual(deferred.binding);
    expect(resolveActionApprovalRouting({ actionId: 'deployments.deploy', spec: getActionSpec('deployments.deploy'), input: concrete,
      context: { surface: 'agent', authority: 'account_automation' }, approvedOperation: operation }).required).toBe(true);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      ...h.mode, binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted }));
    const reopened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...h.mode,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope) });
    expect(reopened.kind).toBe('available');
    if (reopened.kind === 'available') expect(reopened.content.approvedOperation).toEqual(operation);
    const storage = createWorkflowRunStorageTestkit({ runId, accountId, machineId: 'host', state: 'running',
      origin: { kind: 'direct' }, acceptedEnvelope,
      keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse((await h.storage.execute({ operation: 'get', runId }) as {
        keyCensus: unknown }).keyCensus) });
    const seal = (id: string, sequence: string, parentRecordId: string | null, memberOrdinal: string,
      progress: Parameters<typeof sealWorkflowProgressStoredEnvelopeV1>[0]['progress'], owner = accountId, sourceRun = runId) =>
      serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...h.mode,
        binding: { v: 1, purpose: 'invocation_progress', accountId: owner, runId: sourceRun,
          recordId: id, sequence, parentRecordId, memberOrdinal, attempt: '0' }, progress }));
    await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: '{}',
      rootInvocation: { id: 'root', contentEnvelope: seal('root', '0', null, '0', {
        kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] },
        attempt: '0', logicalInvocationRecordId: 'root' }) } });
    const producerProgress = { kind: 'happier.workflow-progress.v1' as const, blockKind: 'action' as const,
      invocationPath: { blockId: 'instantiate', scope: [] }, attempt: '0', logicalInvocationRecordId: 'producer',
      result: DeploymentActionOutputSchemasV1['deployments.templates.instantiate'].parse({ kind: 'applied', environmentId: concrete.environmentId,
        targetLinkId: concrete.targetLinkId, revision: concrete.expectedRevision,
        definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` }, savedSecrets: [] }) };
    const childProgress = { kind: 'happier.workflow-progress.v1' as const, blockKind: 'action' as const,
      invocationPath: { blockId: 'apply', scope: [] }, attempt: '0', logicalInvocationRecordId: invocationId };
    await storage.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, parentAttempt: 0, checkpointEnvelope: '{}', invocations: [
      { id: 'producer', sequence: '1', parentRecordId: 'root', memberOrdinal: '0', lifecycle: 'completed',
        contentEnvelope: seal('producer', '1', 'root', '0', producerProgress) },
      { id: invocationId, sequence: '2', parentRecordId: 'root', memberOrdinal: '1',
        contentEnvelope: seal(invocationId, '2', 'root', '1', childProgress) },
    ] });
    const storedProducer = storage.rowById('producer')!;
    expect(storedProducer.index.lifecycle).toBe('completed');
    expect(openWorkflowProgressStoredEnvelopeV1({ ...h.mode,
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: 'producer',
        sequence: '1', parentRecordId: 'root', memberOrdinal: '0', attempt: '0' },
      envelope: parseWorkflowStoredContentEnvelopeV1(storedProducer.contentEnvelope) }))
      .toMatchObject({ kind: 'available', content: { result: producerProgress.result } });
    let changed: 'input' | 'producer' | 'run' | 'account' | 'unfinished' | null = null;
    const reader = createWorkflowApprovedOperationReader({ storage: { execute: async (request, options) => {
      const response = await storage.execute(request, options);
      if (!changed || !['invocations.current', 'invocations.get'].includes(request.operation)
        || !response || typeof response !== 'object' || !('invocation' in response)) return response;
      const row = response.invocation as { index: Record<string, unknown>; contentEnvelope: string } | null;
      if (row?.index.id !== 'producer') return response;
      return { ...response, invocation: { ...row,
        index: { ...row.index, ...(changed === 'unfinished' ? { lifecycle: 'running' } : {}) },
        contentEnvelope: seal('producer', '1', 'root', '0', { ...producerProgress,
          ...(changed === 'producer' ? { result: { ...producerProgress.result, targetLinkId: 'different-target' } } : {}) },
          changed === 'account' ? 'another-owner' : accountId, changed === 'run' ? '62bd37c4-99c6-41cf-90a5-3a1be2b1e031' : runId) } };
    } }, resolveEncryption: async () => h.encryption });
    const read = (phase: 'prepare' | 'dispatch') => reader({ runId, actionId: 'deployments.deploy', input: preparedConcrete,
      semanticInput: changed === 'input' ? { ...concrete, serverId: 'another-home' } : concrete, context: h.context, phase });
    const proof = await read('prepare');
    expect(proof?.steps, storage.operations().join(',')).toEqual([{ actionId: 'deployments.deploy', input: preparedConcrete }]);
    const producerReads = storage.calls.filter(call => call.operation === 'invocations.current' && call.memberOrdinal === '0');
    expect(producerReads).toHaveLength(1); // Three operands share one exact producer read, never an inventory scan.
    expect(storage.operations()).not.toContain('invocations.list');
    let effects = 0;
    const grant = ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1,
      actions: { families: [], ids: ['deployments.deploy'] },
      targets: { sessions: [], machines: [], environments: [concrete.environmentId] } });
    // The signed Home authorization is an authenticated transport boundary.
    // Its canonical schema retains the independently admitted child-only grant.
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-workflow-child', binding: {
      accountId, principalId: accountId, credentialId: 'workflow-child', grant,
      serverIdentityId: 'home', custodianAccountId: accountId, machineId: 'host', installationId: 'installation',
      actionId: 'deployments.deploy', requestId: actionRequestId, requestEnvelopeDigest: 'A'.repeat(43),
      environmentId: concrete.environmentId, target: { kind: 'machine', machineId: 'host' },
      workflowActionOrigin: { runId, requestId: actionRequestId },
    } });
    const deploymentAction: NonNullable<ActionExecutorDeps['deploymentAction']> = async (actionId, input, context) => {
      if (actionId === 'deployments.deploy') {
        effects++;
        expect(readHostReviewedChildOperationV1(context, actionId, input)?.parent).toEqual(parent);
        expect(context.externalActionExecutionAuthorization).toBe(authorization);
        expect(context.externalActionExecutionAuthorization?.binding.actionId).toBe('deployments.deploy');
        expect(context.externalActionCredential?.grant).toEqual(grant);
        return { ok: true, environmentId: concrete.environmentId, revision: concrete.expectedRevision,
          deploymentId: 'created-deployment', deploymentRevision: 1, state: 'queued' };
      }
      return { ok: true,
        environment: createDeploymentEnvironmentHeaderV1({ id: concrete.environmentId, serverId: 'home' }), targetLinks: [] };
    };
    const executor = createActionExecutor({ deploymentAction,
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deploymentAction),
      readApprovedOperation: async request => request.runId ? reader({ ...request, runId: request.runId }) : null });
    const executionContext: ActionExecutorContext = { ...h.context, surface: 'agent', authority: 'account_automation',
      serverId: 'home', serverIdentityId: 'home', runtimeAccountId: accountId,
      externalActionCredential: { accountId, principalId: accountId, credentialId: 'workflow-child', grant },
      externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
      interactivePresentation: 'unavailable', actionsSettings: normalizeActionsSettingsV1({ v: 1,
        actions: { 'deployments.deploy': { approvalRequiredSurfaces: ['agent'] } } }) };
    expect(resolveActionApprovalRouting({ actionId: 'deployments.deploy', spec: getActionSpec('deployments.deploy'),
      input: preparedConcrete, context: executionContext, settings: executionContext.actionsSettings,
      approvedOperation: proof }).required).toBe(true);
    const beforePrepare = storage.calls.length;
    const prepared = await executor.prepare('deployments.deploy', concrete, executionContext);
    expect(prepared.kind).toBe('ready');
    expect(effects).toBe(0);
    expect(storage.calls.slice(beforePrepare).map(call => call.operation))
      .toEqual(['get', 'invocations.get', 'invocations.get', 'invocations.current']);
    for (const control of ['input', 'producer', 'run', 'account', 'unfinished'] as const) {
      changed = control;
      expect(await read('prepare'), control).toBeNull();
    }
    changed = null;
    await storage.execute({ operation: 'invocations.fact', runId, invocationId, invocationAttempt: '0',
      expectedContentRevision: '0', expectedLifecycle: 'pending', lifecycle: 'admitting',
      contentEnvelope: seal(invocationId, '2', 'root', '1', { ...childProgress, execution: {
        kind: 'action', actionId: 'deployments.deploy', actionRequestId, localInputId: 'local', input: concrete,
      } }) });
    expect((await read('dispatch'))?.steps).toEqual([{ actionId: 'deployments.deploy', input: preparedConcrete }]);
    const beforeDispatch = storage.calls.length;
    if (prepared.kind === 'ready') expect(await prepared.invocation.run()).toMatchObject({ ok: true });
    // The exact prepared child spends its retained admission without reopening Run custody.
    expect(storage.calls.slice(beforeDispatch)).toHaveLength(0);
    expect(effects).toBe(1);
    const setupOnlyGrant = ApiTokenGrantV1Schema.parse({ ...grant, actions: { families: [], ids: [parent.actionId] } });
    const setupOnlyContext: ActionExecutorContext = { ...executionContext,
      externalActionCredential: { ...executionContext.externalActionCredential!, grant: setupOnlyGrant },
      externalActionExecutionAuthorization: { ...authorization, binding: { ...authorization.binding, grant: setupOnlyGrant } } };
    expect(await executor.execute('deployments.deploy', concrete, setupOnlyContext))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(effects).toBe(1);
    let directEffects = 0;
    const directTransport: NonNullable<ActionExecutorDeps['deploymentAction']> = async (actionId, input, context) => {
      if (actionId !== 'deployments.deploy') return deploymentAction(actionId, input, context);
      directEffects++;
      expect(readHostReviewedChildOperationV1(context, actionId, input)?.parent).toEqual(parent);
      expect(context.externalActionExecutionAuthorization).toBe(authorization);
      return { ok: true, environmentId: concrete.environmentId, revision: concrete.expectedRevision,
        deploymentId: 'direct-created-deployment', deploymentRevision: 1, state: 'queued' };
    };
    const directExecutor = createActionExecutor({ deploymentAction: directTransport,
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(directTransport) });
    const executeIssued = async (context: ActionExecutorContext) => {
      const admission = await reader({ runId, actionId: 'deployments.deploy', input: concrete,
        semanticInput: concrete, context, phase: 'dispatch' });
      expect(typeof admission?.invokeReviewedChild).toBe('function');
      return admission?.invokeReviewedChild?.(issued => directExecutor.execute('deployments.deploy', concrete, issued));
    };
    expect(await executeIssued(executionContext)).toMatchObject({ ok: true });
    expect(await executeIssued(setupOnlyContext)).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(directEffects).toBe(1);
    changed = 'producer';
    expect(await read('dispatch')).toBeNull();
  });

  it.each(['canonical', 'legacy'] as const)('binds %s selected trigger consent to prepared effects and checks the actual post-hook semantic input', async storedShape => {
    const h = await fixture(false);
    const triggerId = 'selected-deployment';
    const automationId = 'deployment-automation';
    const fixed = { serverId: 'home', environmentId: 'staging', targetLinkId: 'runtime', whenBusy: 'supersede' as const };
    const semanticInput = { ...fixed, sha: 'a'.repeat(40), requestKey: 'push-one' };
    const deployDefinition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [
      { name: 'sha', valueType: 'string', required: true }, { name: 'requestKey', valueType: 'string', required: true },
    ], defaults: {}, blocks: [
      { kind: 'action', id: 'apply', actionId: 'deployments.deploy',
        input: { ...Object.fromEntries(Object.entries(fixed).map(([name, value]) => [name, { kind: 'literal', value }])),
          sha: { kind: 'input', name: 'sha' }, requestKey: { kind: 'input', name: 'requestKey' } } },
    ] });
    const preparedInput = DeploymentDeployInputV1Schema.parse({ ...fixed, expectedRevision: 3,
      expectedTargetLinkRevision: 2, requestKey: semanticInput.requestKey,
      contentArtifactId: 'reviewed-candidate', contentHeaderVersion: 1, contentBodyVersion: 1 });
    let row: ReturnType<typeof AutomationDefinitionDetailSchema.parse> | undefined;
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected mutation or inventory'); };
    const triggerReads: string[] = [];
    const triggers = createAccountWorkflowTriggerActions({ automations: {
      get: async id => { triggerReads.push(id); return id === automationId ? row ?? null : null; },
      list: async () => ({ automations: [], nextCursor: null }), listDetails: async () => ({ automations: [], nextCursor: null }),
      create: async request => {
        const selected = request.triggers[0];
        if (!selected || selected.trigger.kind !== 'pluginEvent') throw new Error('Expected Event');
        const sourceSelectorId = 'sourceSelectorId' in selected.trigger ? selected.trigger.sourceSelectorId : AutomationSourceSelectorIdV1Schema.parse('00000000-0000-4000-8000-000000000001');
        const triggerDefinitionEnvelope = 'triggerDefinitionEnvelope' in selected.trigger ? selected.trigger.triggerDefinitionEnvelope
          : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, automationId: request.automationId,
            triggerId: AutomationTriggerIdSchema.parse(selected.triggerId), triggerRevision: 0, triggerKind: 'pluginEvent',
            eventRef: selected.trigger.eventRef, sourceSelectorId }, definition: {
            v: 1, sourceInstanceId: selected.trigger.sourceInstanceId, sourceConfig: selected.trigger.sourceConfig,
            displayLabel: selected.trigger.displayLabel, filter: selected.trigger.filter, maximumObservationAgeMs: selected.trigger.maximumObservationAgeMs } });
        row = AutomationDefinitionDetailSchema.parse({ id: request.automationId, name: request.name, description: null,
          enabled: request.enabled, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null,
          createdAt: 1, updatedAt: 1, workflowDefinitionId: null, scopeSessionId: null,
          assignments: request.assignments?.map(assignment => ({ ...assignment, enabled: assignment.enabled ?? true,
            priority: assignment.priority ?? 0, updatedAt: 1 })), executionRecipe: request.executionRecipe,
          triggers: [{ kind: 'pluginEvent', id: selected.triggerId, revision: 0, createdAt: 1, updatedAt: 1,
            enabled: selected.trigger.enabled, eventRef: selected.trigger.eventRef, sourceSelectorId,
            sourceContractVersion: selected.trigger.sourceContractVersion, observation: { kind: 'checkpointedPull', watcher: null },
            sourceStatus: null, sourceCatalogStatus: null, triggerDefinitionEnvelope: JSON.stringify(triggerDefinitionEnvelope) }] });
        return row;
      }, reconcile: unavailable, delete: unavailable },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      resolveWorkflow: unavailable, randomBytes: size => new Uint8Array(size),
      newId: (() => { let id = 0; return () => ++id === 1 ? triggerId : automationId; })(),
      nativeAccount: { accountId, serverId: 'home', isCurrent: async () => true } });
    const saved = await triggers.add({ target: { kind: 'inline', definition: deployDefinition },
      project: { machineId: 'host', directory: '/repo' }, deployment: {}, actionApproval: 'automatic',
      trigger: { kind: 'pluginEvent', enabled: true,
        eventRef: { pluginId: 'happier.scm.forge.github', localId: 'automation/repository-pushed-v1' },
        sourceInstanceId: 'repository', sourceContractVersion: 1, sourceConfig: {}, displayLabel: 'Repository',
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
          machineId: 'host', materializationId: 'github-install', pluginId: 'happier.scm.forge.github' } },
        filter: null, maximumObservationAgeMs: null },
    }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: accountId,
      actionRequestId: 'real-trigger-save' });
    const savedOperation = saved.set.context?.actionApprovals?.[0]?.operation;
    if (!savedOperation || !row || !saved.set.context) throw new Error('Real Save must produce exact consent');
    let operation = savedOperation;
    if (storedShape === 'legacy') {
      // Provenance: the current-dev workflowDeploymentConsent writer before O4
      // emitted this exact private person/save/program shape with empty steps.
      const { actionApproval: _choice, ...legacySave } = savedOperation.parent.input;
      operation = { ...savedOperation, parent: { ...savedOperation.parent,
        input: { ...legacySave, deployApproval: 'automatic' } }, steps: [] };
      const { actionApprovals: _current, ...legacyContext } = saved.set.context;
      if (row.executionRecipe?.v !== 2) throw new Error('Expected Workflow recipe');
      row = { ...row, executionRecipe: { ...row.executionRecipe, workflow: { t: 'plain', v: PluginJsonValueV2Schema.parse({
        ...legacyContext, deploymentTriggers: [{ triggerId, approval: { savedFor: { automationId, triggerId },
          savedBy: { kind: 'person', accountId }, operation, basis: { variables: { LOG_LEVEL: 'before-change' }, protection: 'nonProduction' },
          program: { definition: deployDefinition, children: {} } } }],
      }) } } };
    }
    const accepted = WorkflowAcceptedSnapshotV1Schema.parse({ ...h.approved, approvedOperation: operation,
      definition: deployDefinition, authoredDefinition: deployDefinition,
      inputs: { sha: semanticInput.sha, requestKey: semanticInput.requestKey },
      materializedLeaves: [{ ...h.approved.materializedLeaves[0], actionId: 'deployments.deploy', actionInput: semanticInput }] });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted }));
    if (!row) throw new Error('Stored trigger required');
    const event = row.triggers[0];
    if (event?.kind !== 'pluginEvent') throw new Error('Stored Event required');
    const evidence = { v: 1 as const, kind: 'pluginEvent' as const, eventRef: event.eventRef,
      sourceSelectorId: event.sourceSelectorId, occurrenceId: 'delivery-one', occurredAt: 1, payload: { after: semanticInput.sha } };
    const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'pluginEvent', triggerId,
      triggerRevision: event.revision, occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence }), occurredAt: 1,
      evidence: { eventRef: event.eventRef, sourceSelectorId: event.sourceSelectorId } });
    const reader = createWorkflowApprovedOperationReader({ storage: { execute: async (request, options) => {
      const result = await h.storage.execute(request, options);
      return request.operation === 'get' && result && typeof result === 'object' && 'run' in result ? {
        ...result, acceptedEnvelope, run: { ...WorkflowRunSummaryV1Schema.parse(result.run),
          origin: { kind: 'automation', automationId, cause } },
      } : result;
    } }, resolveEncryption: async () => h.encryption,
      readSavedTriggerConsent: input => triggers.readSavedConsent(input, input.context) });
    const context: ActionExecutorContext = { ...h.context, surface: 'agent', authority: 'account_automation', serverId: 'home',
      interactivePresentation: 'unavailable' };
    const read = (actualSemanticInput: unknown, input: unknown = preparedInput) => reader({ runId,
      actionId: 'deployments.deploy', input, semanticInput: actualSemanticInput, context, phase: 'prepare' });
    const proof = await read(semanticInput);
    expect(proof?.steps).toEqual([{ actionId: 'deployments.deploy', input: preparedInput }]);
    for (const changed of [{ whenBusy: 'refuse' }, { targetLinkId: 'foreign' }, { environmentId: 'foreign' },
      { sourceMethod: 'upload' }]) expect(await read({ ...semanticInput, ...changed })).toBeNull();
    expect(await read(undefined)).toBeNull();
    const deploymentAction = async () => ({ ok: true as const,
      environment: createDeploymentEnvironmentHeaderV1({ id: 'staging', serverId: 'home' }), targetLinks: [] });
    for (const changed of [null, { whenBusy: 'refuse' }, { targetLinkId: 'foreign' }, { sourceMethod: 'upload' }]) {
      // The plugin interception is an external extension boundary; the real
      // executor, private reader, codecs and selected trigger owner stay live.
      const executor = createActionExecutor({
        deploymentAction, resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deploymentAction),
        interceptActionExecution: async () => ({ status: 'continue', input: { ...semanticInput, ...changed } }),
        readApprovedOperation: async request => request.runId ? reader({ ...request, runId: request.runId }) : null,
      });
      const result = await executor.prepare('deployments.deploy', semanticInput, context);
      if (changed === null) expect(result.kind).toBe('ready');
      else expect(result).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'action_interactive_review_required' } });
    }
    expect(triggerReads.every(id => id === automationId)).toBe(true);
    await h.storage.execute({ operation: 'invocations.fact', runId, invocationId, invocationAttempt: '0',
      expectedContentRevision: '0', expectedLifecycle: 'pending', lifecycle: 'admitting',
      contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationId,
          sequence: '1', parentRecordId: 'root', memberOrdinal: '0', attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', blockKind: 'action', invocationPath: { blockId: 'apply', scope: [] },
          attempt: '0', logicalInvocationRecordId: invocationId,
          execution: { kind: 'action', actionId: 'deployments.deploy', actionRequestId, localInputId: 'local', input: semanticInput } },
      })),
    });
    const dispatch = () => reader({ runId, actionId: 'deployments.deploy', input: preparedInput,
      semanticInput, context, phase: 'dispatch' });
    expect((await dispatch())?.steps).toEqual([{ actionId: 'deployments.deploy', input: preparedInput }]);
    let effects = 0;
    const childTransport: NonNullable<ActionExecutorDeps['deploymentAction']> = async (actionId, input, issued) => {
      if (actionId !== 'deployments.deploy') return deploymentAction();
      effects++;
      expect(input).toEqual(preparedInput);
      expect(readHostReviewedChildOperationV1(issued, actionId, input)?.parent).toEqual(operation.parent);
      return { ok: true, environmentId: 'staging', revision: 3, deploymentId: 'saved-trigger-deploy',
        deploymentRevision: 1, state: 'queued' };
    };
    const childExecutor = createActionExecutor({ deploymentAction: childTransport,
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(childTransport) });
    const required = await reader({ runId, actionId: 'deployments.deploy', input: preparedInput, semanticInput,
      context: { ...context, actionsSettings: normalizeActionsSettingsV1({ v: 1,
        actions: { 'deployments.deploy': { approvalRequiredSurfaces: ['agent'] } } }) }, phase: 'dispatch' });
    expect(typeof required?.invokeReviewedChild).toBe('function');
    expect(await required?.invokeReviewedChild?.(issued => childExecutor.execute('deployments.deploy', preparedInput, issued)))
      .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    expect(effects).toBe(0);
    const automatic = await dispatch();
    expect(await automatic?.invokeReviewedChild?.(issued => childExecutor.execute('deployments.deploy', preparedInput, issued)))
      .toMatchObject({ ok: true });
    expect(effects).toBe(1);
    if (!row) throw new Error('Stored Save required');
    row = { ...row, enabled: false };
    expect(await dispatch()).toBeNull();
  });

  it('requires exact completed parent approval rather than frozen Workflow policy or an approval bypass', async () => {
    await expect(prepareWorkflowApprovedOperationSnapshot({ snapshot: snapshot(), parent, steps,
      context: { runtimeAccountId: accountId, surface: 'ui', authority: 'present_user', bypassApprovals: true } }))
      .rejects.toMatchObject({ code: 'approval_required' });
    await expect(prepareWorkflowApprovedOperationSnapshot({ snapshot: snapshot(), parent: { ...parent,
      input: { ...parent.input, machineId: 'changed' } }, steps, context: approvedContext() }))
      .rejects.toMatchObject({ code: 'approval_required' });
    const review = approvedContext();
    await expect(prepareWorkflowApprovedOperationSnapshot({ snapshot: snapshot(), parent, steps,
      context: { ...review, presentUserApproval: { ...review.presentUserApproval!, decidingAccountId: undefined } } }))
      .rejects.toMatchObject({ code: 'approval_required' });
    const mutableParent = { ...parent, input: { ...parent.input } };
    const prepared = await prepareWorkflowApprovedOperationSnapshot({ snapshot: snapshot(), parent: mutableParent, steps, context: approvedContext() });
    expect(prepared.approvedOperation).toEqual({ parent, approvedBy: { accountId }, steps });
    mutableParent.input.machineId = 'changed-after-preparation';
    expect(prepared.approvedOperation?.parent.input.machineId).toBe('host');
  });

  it('reopens stored approval for each exact pending/admitting invocation and withdraws it on cancellation', async () => {
    const h = await fixture();
    expect(await h.reader({ runId, context: h.context, phase: 'prepare' })).toEqual(h.approved.approvedOperation);
    expect(await h.reader({ runId, context: h.context, phase: 'dispatch' })).toBeNull();
    await h.admit();
    expect(await h.reader({ runId, context: h.context, phase: 'dispatch' })).toEqual(h.approved.approvedOperation);
    const reads = h.storage.calls.filter(call => call.operation === 'get');
    expect(reads).toHaveLength(3);
    expect(h.storage.operations()).not.toContain('list');
    h.storage.requestControl('cancelled');
    expect(await h.reader({ runId, context: h.context, phase: 'dispatch' })).toBeNull();
  });

  it('refuses changed durable child input and arbitrary matching-run callers', async () => {
    const h = await fixture();
    await h.admit({ ...steps[0]!.input, machineId: 'different-target' });
    expect(await h.reader({ runId, context: h.context, phase: 'dispatch' })).toBeNull();
    expect(await h.reader({ runId, context: { actionRequestId }, phase: 'prepare' })).toBeNull();
    expect(await h.reader({ runId, context: { ...h.context, actionRequestId: `${runId}/another/0` }, phase: 'prepare' })).toBeNull();
  });

  it('does not treat an ordinary Workflow start or its frozen present-user policy as approval for children', async () => {
    const h = await fixture(false);
    await h.admit();
    expect(await h.reader({ runId, context: h.context, phase: 'prepare' })).toBeNull();
    expect(await h.reader({ runId, context: h.context, phase: 'dispatch' })).toBeNull();
  });

  it('does not spend copied trigger Save proof without its live selected private trigger', async () => {
    const h = await fixture(false);
    const accepted = WorkflowAcceptedSnapshotV1Schema.parse({ ...h.approved,
      approvedOperation: { approvedBy: { accountId }, steps,
        parent: { actionId: 'workflow.trigger.update', input: { automationId: 'deployment-automation', triggerId: 'deployment-trigger' } } } });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted }));
    // Run storage is the external boundary; the real reader must not interpret
    // a copied person Save as ordinary parent consent or assume a current row.
    const reader = createWorkflowApprovedOperationReader({ storage: { execute: async (operation, options) => {
      const result = await h.storage.execute(operation, options);
      return operation.operation === 'get' && result && typeof result === 'object' ? { ...result, acceptedEnvelope } : result;
    } }, resolveEncryption: async () => h.encryption });
    expect(await reader({ runId, context: h.context, phase: 'prepare' })).toBeNull();
    await h.admit();
    expect(await reader({ runId, context: h.context, phase: 'dispatch' })).toBeNull();
  });

  it('reopens person-saved exact schedule consent at both admission phases and restores a hold on changed input or disable', async () => {
    const h = await fixture(false);
    const triggerId = 'exact-schedule';
    const automationId = 'exact-command-automation';
    const operation = await prepareWorkflowApprovedOperation({ parent: { actionId: 'workflow.trigger.add', input: {
      target: { kind: 'inline', definition }, project: { machineId: 'host', directory: '/repo' },
      trigger: { kind: 'schedule', enabled: true, schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } },
      actionApproval: 'automatic',
    } }, steps, context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: accountId, serverId: 'home', actionRequestId: 'save-schedule' },
      nativeAccount: { accountId, serverId: 'home', isCurrent: async () => true } });
    const accepted = { ...h.approved, approvedOperation: operation };
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted }));
    let row = AutomationDefinitionDetailSchema.parse({ id: automationId, name: 'Scheduled command', description: null,
      enabled: true, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null,
      createdAt: 1, updatedAt: 1, assignments: [{ machineId: 'host', enabled: true, priority: 0, updatedAt: 1 }],
      triggers: [{ id: triggerId, revision: 0, kind: 'schedule', enabled: true, createdAt: 1, updatedAt: 1,
        schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null }, nextRunAt: 2, triggerDefinitionEnvelope: null }],
      executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'plain', v: {
        workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition: definition,
        actionApprovals: [{ triggerId, operation }],
      } } },
    });
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected Automation mutation or inventory'); };
    const triggerReads: string[] = [];
    const triggers = createAccountWorkflowTriggerActions({
      automations: { get: async id => { triggerReads.push(id); return id === automationId ? row : null; },
        list: unavailable, listDetails: unavailable, create: unavailable, reconcile: unavailable, delete: unavailable },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      resolveWorkflow: unavailable, randomBytes: size => new Uint8Array(size), newId: () => 'unused',
    });
    const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'schedule', triggerId,
      triggerRevision: 0, occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId,
        evidence: { v: 1, kind: 'schedule', scheduledFor: 1 } }), occurredAt: 1, evidence: { scheduledFor: 1 } });
    const reader = createWorkflowApprovedOperationReader({ storage: { execute: async (request, options) => {
      const result = await h.storage.execute(request, options);
      return request.operation === 'get' && result && typeof result === 'object' && 'run' in result ? {
        ...result, acceptedEnvelope, run: { ...WorkflowRunSummaryV1Schema.parse(result.run),
          origin: { kind: 'automation', automationId, cause } },
      } : result;
    } }, resolveEncryption: async () => h.encryption,
      readSavedTriggerConsent: input => triggers.readSavedConsent(input, input.context) });
    for (const phase of ['prepare', 'dispatch'] as const) {
      if (phase === 'dispatch') await h.admit();
      const proof = await reader({ runId, actionId: 'machines.setup.apply', input: steps[0]!.input, context: h.context, phase });
      expect(proof?.steps).toEqual(steps);
      expect(resolveActionApprovalRouting({ actionId: 'machines.setup.apply', spec: getActionSpec('machines.setup.apply'),
        input: steps[0]!.input, context: { surface: 'agent', authority: 'account_automation' }, approvedOperation: proof }).required).toBe(false);
      expect(resolveActionApprovalRouting({ actionId: 'machines.setup.apply', spec: getActionSpec('machines.setup.apply'),
        input: { ...steps[0]!.input, machineId: 'changed' }, context: { surface: 'agent', authority: 'account_automation' },
        approvedOperation: proof }).required).toBe(true);
      expect(resolveActionApprovalRouting({ actionId: 'machines.setup.apply', spec: getActionSpec('machines.setup.apply'),
        input: steps[0]!.input, context: { surface: 'agent', authority: 'account_automation' }, approvedOperation: proof,
        settings: normalizeActionsSettingsV1({ v: 1, actions: { 'machines.setup.apply': { approvalRequiredSurfaces: ['agent'] } } }) }).required).toBe(true);
    }
    expect(triggerReads).toEqual([automationId, automationId]);
    row = { ...row, enabled: false };
    expect(await reader({ runId, actionId: 'machines.setup.apply', input: steps[0]!.input, context: h.context, phase: 'dispatch' })).toBeNull();
  });

  it('keeps transient input and undiscovered contributed input out of durable parent approval', async () => {
    const confidentialSteps: WorkflowApprovedOperationV1['steps'] = [
      { actionId: 'bugreport.submit', input: { pastedCliDoctorSnapshotJson: 'private diagnostic' } },
      { actionId: 'machines.setup.apply', input: { setup: { value: { _isSecretValue: true, value: 'transient' } } } },
      { actionId: 'plugin.acme.install', input: { password: 'transient' } },
    ];
    for (const step of confidentialSteps) {
      await expect(prepareWorkflowApprovedOperationSnapshot({ snapshot: snapshot(), parent,
        steps: [step], context: approvedContext() })).rejects.toMatchObject({ code: 'approval_required' });
    }
  });

  it('does no storage work for an unbound caller and reads only its selected Run and invocation when bound', async () => {
    const h = await fixture();
    const before = h.storage.calls.length;
    expect(await h.reader({ runId, context: {}, phase: 'prepare' })).toBeNull();
    expect(h.storage.calls.slice(before)).toEqual([]);
    expect(await h.reader({ runId, context: h.context, phase: 'prepare' })).toEqual(h.approved.approvedOperation);
    expect(h.storage.calls.slice(before)).toEqual([
      { operation: 'get', runId }, { operation: 'invocations.get', runId, invocationId },
    ]);
  });

  it('cannot spend one admitting invocation request on a different approved child', async () => {
    const h = await fixture();
    const multiple = await prepareWorkflowApprovedOperationSnapshot({ snapshot: snapshot(), parent,
      steps: [...steps, { actionId: steps[0]!.actionId, input: { ...steps[0]!.input, machineId: 'another-approved-target' } }],
      context: approvedContext() });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: multiple }));
    const reader = createWorkflowApprovedOperationReader({ storage: { execute: async (operation, options) => {
      const result = await h.storage.execute(operation, options);
      return operation.operation === 'get' && result && typeof result === 'object' ? { ...result, acceptedEnvelope } : result;
    } }, resolveEncryption: async () => ({ witness: { mode: 'plain' } }) });
    expect((await reader({ runId, context: h.context, phase: 'prepare' }))?.steps).toEqual(steps);
    await h.admit();
    expect((await reader({ runId, context: h.context, phase: 'dispatch' }))?.steps).toEqual(steps);
    const context: ActionExecutorContext = { ...h.context, surface: 'agent', authority: 'account_automation' };
    const admission = await reader({ runId, context, phase: 'dispatch', actionId: 'machines.setup.apply', input: steps[0]!.input });
    expect(await admission?.invokeReviewedChild?.(async issued =>
      readHostReviewedChildOperationV1(issued, 'machines.setup.apply', steps[0]!.input)?.parent)).toEqual(parent);
    expect(await reader({ runId, context, phase: 'dispatch', actionId: 'machines.setup.apply',
      input: steps[0]!.input, semanticInput: { ...steps[0]!.input, machineId: 'another-approved-target' } })).toBeNull();
    expect(await reader({ runId, context, phase: 'dispatch', actionId: 'deployments.deploy', input: steps[0]!.input })).toBeNull();
  });

  it('fails closed on revoked reads and unavailable/mode-inconsistent private content', async () => {
    const h = await fixture();
    const revoked = createWorkflowApprovedOperationReader({ storage: { execute: async () => { throw new Error('run_not_found'); } },
      resolveEncryption: async () => ({ witness: { mode: 'plain' } }) });
    expect(await revoked({ runId, context: h.context, phase: 'prepare' })).toBeNull();
    const noKeys = createWorkflowApprovedOperationReader({ storage: h.storage, resolveEncryption: async () => null });
    expect(await noKeys({ runId, context: h.context, phase: 'prepare' })).toBeNull();
    const corrupt = createWorkflowApprovedOperationReader({ storage: { execute: async (operation, options) => {
      const result = await h.storage.execute(operation, options);
      return operation.operation === 'get' && result && typeof result === 'object'
        ? { ...result, acceptedEnvelope: JSON.stringify({ t: 'encrypted', c: 'not-plain' }) } : result;
    } }, resolveEncryption: async () => ({ witness: { mode: 'plain' } }) });
    expect(await corrupt({ runId, context: h.context, phase: 'prepare' })).toBeNull();
  });

  it('opens existing E2EE Run keys and declines unreadable Team-shared approval without preparing grants', async () => {
    const h = await fixture(true, true);
    await h.admit();
    expect(await h.reader({ runId, context: h.context, phase: 'dispatch' })).toEqual(h.approved.approvedOperation);
    const unreadable = createWorkflowApprovedOperationReader({ storage: { execute: async (operation, options) => {
      const result = await h.storage.execute(operation, options);
      if (operation.operation !== 'get' || !result || typeof result !== 'object' || !('keyCensus' in result)) return result;
      return { ...result, keyCensus: { ...WorkflowRunRecipientCensusResponseV1Schema.parse(result.keyCensus),
        access: 'view', callerDataEncryptionKey: null } };
    } }, resolveEncryption: async () => h.encryption });
    expect(await unreadable({ runId, context: h.context, phase: 'dispatch' })).toBeNull();
    expect(h.storage.operations()).not.toContain('run-key.commit');
  });
});
