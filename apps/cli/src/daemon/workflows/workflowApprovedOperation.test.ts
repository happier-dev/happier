import { describe, expect, it } from 'vitest';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { prepareWorkflowRunDataKeyV1, type WorkflowRunReadEncryptionV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { WorkflowAcceptedSnapshotV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { createPlainWorkflowRunKeyCensusFixture, createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import { createWorkflowApprovedOperationReader, prepareWorkflowApprovedOperationSnapshot } from './workflowApprovedOperation';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createActionExecutor, readHostReviewedChildOperationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
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

});
