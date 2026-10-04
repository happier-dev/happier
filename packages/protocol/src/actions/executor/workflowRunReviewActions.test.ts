import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '../../crypto/accountScopedCipher.js';
import { sealEncryptedDataKeyEnvelopeV1 } from '../../crypto/encryptedDataKeyEnvelopeV1.js';
import { encodeBase64 } from '../../crypto/base64.js';

import { createWorkflowAccountRunActionOwner, type WorkflowAccountRunActionDeps } from './workflowRunActions.js';
import { createWorkflowActionExecutor } from './workflowAccountActions.js';
import type { WorkflowActionExecuteArgs } from './types.js';
import {
  WorkflowDefinitionV1Schema, WorkflowProgressEnvelopeV1Schema, WorkflowRunInvocationIndexV1Schema,
  WorkflowRunSummaryV1Schema, deriveWorkflowReplacementId,
  openWorkflowProgressStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
  type WorkflowDefinitionV1, type WorkflowProgressEnvelopeV1, type WorkflowMaterializedLeafV1,
  type WorkflowAcceptedAuthorizationV1,
} from '../../workflows/index.js';

const runId = '11111111-1111-4111-8111-111111111111';
const rootId = '22222222-2222-4222-8222-222222222222';
const heldId = '33333333-3333-4333-8333-333333333333';
const timestamp = '2026-01-01T00:00:00.000Z';
const actor = { surface: 'ui', authority: 'present_user', callerPermissionMode: 'safe-yolo' } as const;
const target = { runId, invocation: { recordId: heldId }, expectedContentRevision: '4' };
const program = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
  { kind: 'step', id: 'draft', document: { text: 'Draft', references: [], attachments: [] }, input: [],
    result: { kind: 'decision', decisions: ['continue', 'stop'] }, pauseForReview: true },
] });

// Storage is the HTTP boundary. Domain authority, strict envelopes, and the result codec remain real.
function harness(options: Readonly<{
  definition?: WorkflowDefinitionV1;
  progress?: Partial<WorkflowProgressEnvelopeV1>;
  lifecycle?: 'admitting' | 'running' | 'waiting_for_approval' | 'waiting_for_review';
  callerAccountId?: string;
  loseResponse?: boolean;
  canContinue?: boolean;
  e2ee?: boolean;
  materializedLeaves?: WorkflowMaterializedLeafV1[];
  access?: 'view' | 'edit';
  authorization?: WorkflowAcceptedAuthorizationV1;
}> = {}) {
  const runDataKey = options.e2ee ? randomBytes(32) : undefined;
  const ownerMachineKey = options.e2ee ? randomBytes(32) : undefined;
  const callerMachineKey = options.e2ee ? randomBytes(32) : undefined;
  const ownerMaterial = ownerMachineKey && createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
    material: { type: 'dataKey', machineKey: ownerMachineKey }, dataKeyPublicKey: x25519.getPublicKey(ownerMachineKey) });
  const callerMaterial = callerMachineKey && createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
    material: { type: 'dataKey', machineKey: callerMachineKey }, dataKeyPublicKey: x25519.getPublicKey(callerMachineKey) });
  const crypto = runDataKey ? { mode: 'e2ee' as const, runDataKey, randomBytes } : { mode: 'plain' as const };
  const ownerWitness = ownerMaterial ? { mode: 'e2ee' as const, version: 8, contentKeyFingerprint: ownerMaterial.contentPublicKeyFingerprint }
    : { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
  const ownerKeyEnvelope = ownerMachineKey && runDataKey ? encodeBase64(sealEncryptedDataKeyEnvelopeV1({
    dataKey: runDataKey, recipientPublicKey: x25519.getPublicKey(ownerMachineKey), randomBytes })) : null;
  const callerKeyEnvelope = callerMachineKey && runDataKey ? encodeBase64(sealEncryptedDataKeyEnvelopeV1({
    dataKey: runDataKey, recipientPublicKey: x25519.getPublicKey(callerMachineKey), randomBytes })) : null;
  const definition = options.definition ?? program;
  const run = WorkflowRunSummaryV1Schema.parse({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'waiting_for_review', revision: 7,
    machineId: 'machine-a', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
    availability: { pause: true, resumeBoundary: false,
       restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
    createdAt: timestamp, updatedAt: timestamp });
  const rows = new Map<string, { index: ReturnType<typeof WorkflowRunInvocationIndexV1Schema.parse>; contentEnvelope: string; parentRevision: number }>();
  function storeRow(id: string, ordinal: string, progress: WorkflowProgressEnvelopeV1, lifecycle: 'admitting' | 'running' | 'waiting_for_approval' | 'waiting_for_review' | 'superseded') {
    const index = WorkflowRunInvocationIndexV1Schema.parse({ id, runId, sequence: id === rootId ? '0' : String(BigInt(progress.attempt) + 1n),
      parentRecordId: id === rootId ? null : rootId, memberOrdinal: ordinal, attempt: progress.attempt, contentRevision: id === rootId ? '0' : '4',
      lifecycle, createdAt: timestamp, updatedAt: timestamp });
    rows.set(id, { index, parentRevision: run.revision, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      ...crypto, binding: { v: 1, purpose: 'invocation_progress', accountId: 'owner', runId, recordId: id,
        sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: ordinal, attempt: progress.attempt }, progress })) });
  }
  storeRow(rootId, '0', WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
    invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId }), 'running');
  const leaf = definition.blocks[0]!;
  const heldProgress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
    invocationPath: { blockId: leaf.id, scope: [] }, blockKind: leaf.kind, attempt: '0', logicalInvocationRecordId: heldId,
    ...(leaf.kind === 'step' ? { execution: { kind: 'session', sessionId: 'conversation', localInputId: 'initial-input' },
      result: 'continue', review: { resultSource: { kind: 'execution_input' } } } : {}), ...options.progress });
  if (heldProgress.execution === undefined) delete heldProgress.execution;
  storeRow(heldId, '0', heldProgress, options.lifecycle ?? 'waiting_for_review');
  const snapshot = { run, keyCensus: { runId, ownerAccountId: 'owner', encryptionMode: crypto.mode, access: options.access ?? 'edit',
    ownerAccountCurrentness: ownerWitness,
    dataEncryptionKey: ownerKeyEnvelope, callerDataEncryptionKey: callerKeyEnvelope, visibleTeamId: null, recipients: [] },
    acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...crypto,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'owner', runId }, acceptedSnapshot: {
        definition, authoredDefinition: definition, startedBy: 'user', workDepth: 0, metadata: null, frozenChildren: {},
        materializedLeaves: options.materializedLeaves ?? [{ sourceKey: '$root', blockId: leaf.id,
          kind: leaf.kind === 'wait' ? 'wait' : 'step', selection: definition.defaults ?? {},
          authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' } }],
        source: { kind: 'inline' }, inputs: {}, machineId: 'machine-a', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: options.authorization ?? { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' } },
      } })), checkpointEnvelope: null, resultEnvelope: null };
  const operations: Readonly<Record<string, unknown>>[] = [];
  let lost = false;
  const deps: WorkflowAccountRunActionDeps = {
    resolveAccountId: async () => options.callerAccountId ?? 'owner',
    resolveEncryption: async () => callerMaterial ? { kind: 'available', material: callerMaterial,
      witness: { mode: 'e2ee', version: 3, contentKeyFingerprint: callerMaterial.contentPublicKeyFingerprint } }
      : { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } },
    definitions: { get: async () => { throw new Error('frozen_review_must_not_read_live_definition'); } },
    normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
    randomBytes: length => {
      if (!options.e2ee) throw new Error('plain_run_is_keyless');
      return randomBytes(length);
    },
    observeRecovery: async () => {
      if (options.canContinue === false) throw new Error('offline_machine_cannot_be_observed');
      return { activity: 'not_active', canReattach: false, canContinueConversation: true };
    },
    storage: { execute: async operation => {
      operations.push(operation);
      if (operation.operation === 'get') return snapshot;
      if (operation.operation === 'run-key.census') return snapshot.keyCensus;
      if (operation.operation === 'invocations.get') {
        const invocation = rows.get(String(operation.invocationId));
        if (!invocation) throw Object.assign(new Error('invocation_not_found'), { code: 'invocation_not_found' });
        return { invocation };
      }
      if (operation.operation === 'invocations.current') return { invocation: rows.get(heldId), parentRevision: run.revision };
      if (operation.operation === 'invocations.publish_draft' || operation.operation === 'invocations.complete_review') {
        if (options.access === 'view') throw Object.assign(new Error('run_access_denied'), {
          response: { status: 403, data: { error: 'run_access_denied' } },
        });
        const row = rows.get(String(operation.invocationId))!;
        if (row.index.contentRevision !== operation.expectedContentRevision) throw Object.assign(new Error('currentness_conflict'), { code: 'currentness_conflict' });
        row.contentEnvelope = String(operation.contentEnvelope);
        row.index = { ...row.index, contentRevision: String(BigInt(row.index.contentRevision) + 1n),
          ...(operation.mode === 'use_result' ? { lifecycle: 'completed' as const } : {}) };
        if (operation.operation === 'invocations.complete_review') {
          run.revision += 1;
          run.state = 'queued';
        }
        row.parentRevision = run.revision;
        if (options.loseResponse && !lost) { lost = true; throw new Error('response_lost'); }
        return operation.operation === 'invocations.publish_draft' ? { invocation: { index: row.index, contentEnvelope: row.contentEnvelope }, parentRevision: run.revision }
          : { run, invocation: row, disposition: operation.mode === 'use_result' ? 'completed' : 'generation_requested' };
      }
      throw new Error(`unexpected_storage_operation:${String(operation.operation)}`);
    } },
  };
  const progress = (id = heldId) => {
    const row = rows.get(id)!;
    const opened = openWorkflowProgressStoredEnvelopeV1({ ...crypto, envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope)!,
      binding: { v: 1, purpose: 'invocation_progress', accountId: 'owner', runId, recordId: id,
        sequence: row.index.sequence, parentRecordId: row.index.parentRecordId, memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt } });
    if (opened.kind !== 'available') throw new Error('progress_unavailable');
    return opened.content;
  };
  return { owner: createWorkflowAccountRunActionOwner(deps), deps, rows, operations, progress, run, ownerWitness, storeRow };
}

describe('Account review Actions', () => {
  it('records a later offline Generate against the last retained same-conversation attempt', async () => {
    const historicalId = '44444444-4444-4444-8444-444444444444';
    const h = harness({ canContinue: false, progress: { execution: undefined, attempt: '1',
      logicalInvocationRecordId: historicalId, previousAttemptRecordId: historicalId,
      reason: { code: 'workflow_conversation_unavailable' },
      recovery: { conversation: 'same_conversation', input: { kind: 'original' } } } });
    h.storeRow(historicalId, '0', WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
      invocationPath: { blockId: 'draft', scope: [] }, blockKind: 'step', attempt: '0', logicalInvocationRecordId: historicalId,
      execution: { kind: 'session', sessionId: 'conversation', localInputId: 'initial-input' }, result: 'continue',
      review: { decision: { kind: 'generate', requestedFromContentRevision: '3' } } }), 'superseded');
    await expect(h.owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'generate' },
      context: actor })).resolves.toMatchObject({ disposition: 'generation_requested' });
    expect(h.progress()).toMatchObject({ attempt: '1', review: { decision: { kind: 'generate' } } });
    expect(h.progress().execution).toBeUndefined();
    expect(h.progress(historicalId)).toMatchObject({ result: 'continue', execution: { localInputId: 'initial-input' } });
  });
  it.each(['use_result', 'generate'] as const)('rejects %s without present-user authority before storage reads', async mode => {
    const h = harness();
    await expect(h.owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode },
      context: { ...actor, authority: 'account_automation', externalActionTarget: { kind: 'machine', machineId: 'machine-a' } } }))
      .rejects.toMatchObject({ code: 'present_user_required' });
    expect(h.operations).toEqual([]);
  });

  it('accepts supplied bytes with the answering Account while retaining exact owned input', async () => {
    const h = harness({ callerAccountId: 'editor' });
    const result = await h.owner.execute({ actionId: 'workflow.run.invocations.complete_review',
      input: { ...target, mode: 'use_result', value: 'stop' }, context: actor });
    expect(result).toMatchObject({ disposition: 'completed', invocation: { lifecycle: 'completed', contentRevision: '5' } });
    expect(h.progress()).toMatchObject({ result: 'stop', execution: { localInputId: 'initial-input' }, review: {
      resultSource: { kind: 'human', accountId: 'editor' }, decision: { kind: 'use_result', requestedFromContentRevision: '4' } } });
  });

  it('uses the exact stored value and source without generating input', async () => {
    const h = harness();
    await h.owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'use_result' }, context: actor });
    expect(h.progress()).toMatchObject({ result: 'continue', review: { resultSource: { kind: 'execution_input' } } });
    expect(h.operations.filter(operation => operation.operation === 'invocations.complete_review')).toHaveLength(1);
  });

  it('validates against the frozen leaf rather than a cached progress contract', async () => {
    const h = harness({ progress: { resultContract: { kind: 'text' } } });
    const before = h.rows.get(heldId)!.contentEnvelope;
    await expect(h.owner.execute({ actionId: 'workflow.run.invocations.publish_draft', input: { ...target, value: 'maybe' }, context: actor }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(h.rows.get(heldId)!.contentEnvelope).toBe(before);
  });

  it('never rebases a stale human decision onto a newer publication', async () => {
    const h = harness();
    h.rows.get(heldId)!.index = { ...h.rows.get(heldId)!.index, contentRevision: '5' };
    await expect(h.owner.execute({ actionId: 'workflow.run.invocations.complete_review',
      input: { ...target, mode: 'use_result', value: 'stop' }, context: actor })).rejects.toMatchObject({ code: 'currentness_conflict' });
    expect(h.progress().result).toBe('continue');
    expect(h.operations.some(operation => operation.operation === 'invocations.complete_review')).toBe(false);
  });

  it('rejoins the exact accepted plan after response loss and conflicts on different follow-up', async () => {
    const definition = WorkflowDefinitionV1Schema.parse({ ...program, blocks: [{ ...program.blocks[0],
      result: { kind: 'json', schema: { type: 'object', properties: { document: { type: 'string' } }, required: ['document'], additionalProperties: false } } }] });
    const h = harness({ definition, progress: { result: { document: 'First plan' } }, loseResponse: true });
    const args = { actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'use_result',
      value: { document: 'Edited plan' }, followUp: { kind: 'editing' } }, context: actor } as const;
    await expect(h.owner.execute(args)).resolves.toMatchObject({ disposition: 'completed' });
    await expect(h.owner.execute(args)).resolves.toMatchObject({ disposition: 'completed' });
    await expect(h.owner.execute({ ...args, input: { ...args.input, followUp: { kind: 'run_started', runId } } }))
      .rejects.toMatchObject({ code: 'currentness_conflict' });
    expect(h.operations.filter(operation => operation.operation === 'invocations.complete_review')).toHaveLength(1);
    expect(h.progress().result).toEqual({ document: 'Edited plan' });
  });

  it('requires an exact uncertainty acknowledgement before generation', async () => {
    const h = harness({ progress: { uncertainPriorEffects: { activity: 'stopped' } } });
    await expect(h.owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'generate' }, context: actor }))
      .rejects.toMatchObject({ code: 'workflow_outcome_unresolved' });
    await expect(h.owner.execute({ actionId: 'workflow.run.invocations.complete_review',
      input: { ...target, mode: 'generate', acknowledgeUncertainPriorEffects: true }, context: actor })).resolves.toMatchObject({ disposition: 'generation_requested' });
  });

  it('records offline generation intent without live continuation capability', async () => {
    const h = harness({ canContinue: false });
    await expect(h.owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'generate' }, context: actor }))
      .resolves.toMatchObject({ disposition: 'generation_requested', invocation: { id: heldId, lifecycle: 'waiting_for_review' } });
    expect(h.progress()).toMatchObject({ result: 'continue', execution: { localInputId: 'initial-input' },
      review: { decision: { kind: 'generate', requestedFromContentRevision: '4' } } });
    expect(h.run.state).toBe('queued');
    expect(h.rows.size).toBe(2);
  });

  it('records offline Generate for a revocable principal without a caller-side authority validator', async () => {
    const h = harness({ canContinue: false, authorization: { admittedPermissionCeiling: 'safe-yolo',
      principal: { kind: 'api', accountId: 'owner', principalId: 'api-user', credentialId: 'revocable-token' } } });
    await expect(h.owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'generate' },
      context: { ...actor, callerPermissionMode: 'default' } })).resolves.toMatchObject({ disposition: 'generation_requested' });
    expect(h.progress()).toMatchObject({ review: { decision: { kind: 'generate' } }, execution: { localInputId: 'initial-input' } });
    expect(h.rows.size).toBe(2);
    const use = harness({ authorization: { admittedPermissionCeiling: 'safe-yolo',
      principal: { kind: 'api', accountId: 'owner', principalId: 'api-user', credentialId: 'revocable-token' } } });
    await expect(use.owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'use_result' },
      context: actor })).rejects.toMatchObject({ code: 'run_access_denied' });
  });

  it.each(['admitting', 'running', 'waiting_for_approval'] as const)('publishes the %s initial input without releasing it', async lifecycle => {
    const h = harness({ lifecycle });
    const published = await h.owner.execute({ actionId: 'workflow.run.invocations.publish_draft', input: { ...target, value: 'stop' },
      context: { ...actor, surface: 'agent', authority: 'account_automation' } });
    expect(published).toMatchObject({ invocation: { index: { lifecycle, contentRevision: '5' }, progress: {
      result: 'stop', review: { resultSource: { kind: 'published', by: 'agent' } }, execution: { localInputId: 'initial-input' } } } });
    expect(h.run.revision).toBe(7);
  });

  it('records generation intent on the held row and rejoins a lost response once', async () => {
    const h = harness({ loseResponse: true });
    const args = { actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'generate' }, context: actor } as const;
    await expect(h.owner.execute(args)).resolves.toMatchObject({ disposition: 'generation_requested', invocation: { id: heldId, lifecycle: 'waiting_for_review' } });
    await expect(h.owner.execute(args)).resolves.toMatchObject({ disposition: 'generation_requested' });
    expect(h.progress()).toMatchObject({ result: 'continue', execution: { localInputId: 'initial-input' },
      review: { decision: { kind: 'generate', requestedFromContentRevision: '4' } } });
    expect(h.operations.filter(operation => operation.operation === 'invocations.complete_review')).toHaveLength(1);
    expect(h.rows.size).toBe(2);
  });

  it('rejoins generation after supersession through the deterministic replacement', async () => {
    const h = harness();
    const args = { actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'generate' }, context: actor } as const;
    await h.owner.execute(args);
    const old = h.rows.get(heldId)!;
    old.index = { ...old.index, lifecycle: 'superseded', contentRevision: '6' };
    const replacementId = deriveWorkflowReplacementId(['workflow.review.generate', runId, heldId, '4']);
    const index = { ...old.index, id: replacementId, sequence: '2', attempt: '1', lifecycle: 'pending' as const, contentRevision: '0' };
    h.rows.set(replacementId, { index, parentRevision: h.run.revision, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'owner', runId, recordId: replacementId,
        sequence: '2', attempt: '1', memberOrdinal: '0', parentRecordId: rootId }, progress: { kind: 'happier.workflow-progress.v1',
        blockKind: 'step', invocationPath: { blockId: 'draft', scope: [] }, attempt: '1', logicalInvocationRecordId: heldId, previousAttemptRecordId: heldId } })) });
    await expect(h.owner.execute(args)).resolves.toMatchObject({ disposition: 'generation_requested', invocation: { id: replacementId } });
    expect(h.operations.filter(operation => operation.operation === 'invocations.complete_review')).toHaveLength(1);
    for (const lifecycle of ['superseded', 'cancelled'] as const) {
      const replacement = h.rows.get(replacementId)!;
      replacement.index = { ...replacement.index, lifecycle };
      await expect(h.owner.execute(args)).rejects.toMatchObject({ code: 'currentness_conflict' });
    }
  });

  it('requires current controller dominance for Use', async () => {
    const h = harness();
    await expect(h.owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'use_result' },
      context: { ...actor, callerPermissionMode: 'read-only' } })).rejects.toMatchObject({ code: 'run_access_denied' });
    expect(h.rows.get(heldId)!.index.contentRevision).toBe('4');
  });

  it('continues a fieldless Wait with no result, and refuses generation without a conversation', async () => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'wait', id: 'wait', document: { text: 'Continue?', references: [], attachments: [] } },
    ] });
    const h = harness({ definition });
    await expect(h.owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'generate' }, context: actor }))
      .rejects.toMatchObject({ code: 'continuation_unavailable' });
    await expect(h.owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'use_result' }, context: actor }))
      .resolves.toMatchObject({ disposition: 'completed' });
    expect(h.progress().result).toBeUndefined();
  });

  it('routes both review operations through the Account Action ingress', async () => {
    const h = harness();
    const unavailable = async () => ({ ok: false as const, errorCode: 'source_unavailable' as const, error: 'unused' });
    const execute = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, runs: h.owner,
      definitions: { list: unavailable, get: unavailable, create: unavailable, update: unavailable, edit: unavailable, delete: unavailable } });
    await expect(execute({ actionId: 'workflow.run.invocations.publish_draft', input: { ...target, value: 'stop' }, context: actor }))
      .resolves.toMatchObject({ invocation: { progress: { result: 'stop' } } });
    const args: WorkflowActionExecuteArgs<'workflow.run.invocations.complete_review'> = { actionId: 'workflow.run.invocations.complete_review',
      input: { ...target, expectedContentRevision: '5', mode: 'use_result' }, context: actor };
    await expect(execute(args)).resolves.toMatchObject({ disposition: 'completed' });
  });

  it('rejects publication during the exact generated input but permits a held failed generation', async () => {
    const previousId = '44444444-4444-4444-8444-444444444444';
    const h = harness({ lifecycle: 'running', progress: { attempt: '1', previousAttemptRecordId: previousId, logicalInvocationRecordId: previousId } });
    const index = { ...h.rows.get(heldId)!.index, id: previousId, attempt: '0', sequence: '1', lifecycle: 'superseded' as const };
    h.rows.set(previousId, { index, parentRevision: 7, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'owner', runId, recordId: previousId,
        sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0' }, progress: {
        kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'draft', scope: [] }, attempt: '0',
        logicalInvocationRecordId: previousId, review: { decision: { kind: 'generate', requestedFromContentRevision: '3' } }, result: 'continue' } })) });
    const args = { actionId: 'workflow.run.invocations.publish_draft', input: { ...target, value: 'stop' }, context: actor } as const;
    await expect(h.owner.execute(args)).rejects.toMatchObject({ code: 'ineligible_state' });
    expect(h.progress().result).toBe('continue');
    h.rows.get(heldId)!.index = { ...h.rows.get(heldId)!.index, lifecycle: 'waiting_for_review' };
    await expect(h.owner.execute(args)).resolves.toMatchObject({ invocation: { progress: { result: 'stop' } } });
  });

  it('distinguishes an explicit Wait text contract from fieldless Continue', async () => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'wait', id: 'wait', document: { text: 'Answer', references: [], attachments: [] }, result: { kind: 'text' } },
    ] });
    const h = harness({ definition });
    await expect(h.owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'use_result' }, context: actor }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(h.owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'use_result', value: 'Answered' }, context: actor }))
      .resolves.toMatchObject({ disposition: 'completed' });
  });

  it('checks live revocation even when the admitted ceiling still fits', async () => {
    const h = harness();
    const owner = createWorkflowAccountRunActionOwner({ ...h.deps, isAcceptedAuthorizationCurrent: async () => false });
    await expect(owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'use_result' }, context: actor }))
      .rejects.toMatchObject({ code: 'run_access_denied' });
    expect(h.rows.get(heldId)!.index.contentRevision).toBe('4');
  });

  it('answers an E2EE owner-bound hold using only the Team editor recipient key', async () => {
    const h = harness({ e2ee: true, callerAccountId: 'editor' });
    await h.owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'use_result', value: 'stop' }, context: actor });
    expect(h.progress()).toMatchObject({ result: 'stop', review: { resultSource: { kind: 'human', accountId: 'editor' } } });
    const mutation = h.operations.find(operation => operation.operation === 'invocations.complete_review');
    expect(mutation?.accountCurrentness).toEqual(h.ownerWitness);
    expect(parseWorkflowStoredContentEnvelopeV1(h.rows.get(heldId)!.contentEnvelope)?.t).toBe('encrypted');
  });

  it.each([false, true])('uses the frozen Action contract (terminal completion: %s) without conversation generation', async terminal => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'action', id: 'draft', actionId: 'notify_me', input: {}, pauseForReview: true },
    ] });
    const h = harness({ definition, progress: { result: terminal ? 'terminal' : 'frozen', resultContract: { kind: 'text' } }, materializedLeaves: [{
      sourceKey: '$root', blockId: 'draft', kind: 'action', selection: {}, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' }, actionId: 'notify_me',
      actionContract: { inputSchema: { type: 'object' }, outputSchema: { type: 'string', enum: ['frozen'] },
        ...(terminal ? { completion: { awaits: 'execution_runs', terminalOutputSchema: { type: 'string', enum: ['terminal'] } } } : {}) },
    }] });
    await expect(h.owner.execute({ actionId: 'workflow.run.invocations.publish_draft', input: { ...target, value: 'other' }, context: actor }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(h.owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'generate' }, context: actor }))
      .rejects.toMatchObject({ code: 'continuation_unavailable' });
    await expect(h.owner.execute({ actionId: 'workflow.run.invocations.complete_review', input: { ...target, mode: 'use_result' }, context: actor }))
      .resolves.toMatchObject({ disposition: 'completed' });
  });

  it.each(['workflow.run.invocations.publish_draft', 'workflow.run.invocations.complete_review'] as const)('preserves the view-level grant refusal through %s ingress', async actionId => {
    const h = harness({ access: 'view', callerAccountId: 'viewer' });
    const before = h.rows.get(heldId)!.contentEnvelope;
    const unavailable = async () => ({ ok: false as const, errorCode: 'source_unavailable' as const, error: 'unused' });
    const execute = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, runs: h.owner,
      definitions: { list: unavailable, get: unavailable, create: unavailable, update: unavailable, edit: unavailable, delete: unavailable } });
    const args: Parameters<typeof execute>[0] = actionId === 'workflow.run.invocations.publish_draft'
      ? { actionId, input: { ...target, value: 'stop' }, context: actor }
      : { actionId, input: { ...target, mode: 'use_result' as const }, context: actor };
    await expect(execute(args)).resolves.toMatchObject({ ok: false, errorCode: 'run_access_denied' });
    expect(h.rows.get(heldId)!.contentEnvelope).toBe(before);
    expect(h.rows.get(heldId)!.index.contentRevision).toBe('4');
  });
});
