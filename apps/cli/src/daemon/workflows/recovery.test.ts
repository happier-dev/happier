import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import * as sessionSockets from '@/api/session/sockets';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import {
  createAccountScopedCryptoMaterialSnapshotV1,
  prepareWorkflowRunDataKeyV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  openWorkflowProgressStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
  type JsonValue,
  type WorkflowDefinitionV1,
  type WorkflowProgressEnvelopeV1,
  type WorkflowRunInvocationIndexV1,
  type WorkflowStep,
  type WorkflowMaterializedLeafV1,
  WorkflowRunSummaryV1Schema,
  freezeActionCompletionContractV1,
  getActionSpec,
} from '@happier-dev/protocol';

import { createWorkflowRunRecoveryReader, createWorkflowInvocationRecoveryFactWriter } from './recovery';
import { createWorkflowInvocationRecoveryObserver } from './daemonRuntime';
import { createPlainWorkflowRunKeyCensusFixture, createWorkflowRunStorageTestkit, type WorkflowRunStorageTestkitOperation } from './workflowRunStorage.testkit';
import type { AvailableAutomationAccountEncryptionV1 } from '@/plugins/runtime/automations/automationAccountCurrentness';
import type { SessionInputResultV1 } from '@/session/services/sendSessionMessage';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { normalizePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';

const accountId = 'account-1';
const machineId = 'machine-1';
const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
const now = '2026-09-08T12:00:00.000Z';
const availability = { pause: false, resumeBoundary: false,
    restoreWorkspace: false, cancel: false, inspectExecution: true, disabledReasons: [] };

it.each(['retained', 'observed'] as const)('retains Project consent custody (%s) without granting result review or changing operation correspondence', async scenario => {
  const rootId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
  const childId = '33333333-3333-4333-8333-333333333333';
  const pending = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed' };
  const input = { workspace: { serverId: 'home', workspaceId: 'workspace', machineId, rootPath: '/repo' }, phase: 'setup' };
  const operation = { version: 1 as const, operationId: 'original-operation', revision: 1, actionId: 'projects.prepare',
    state: 'accepted' as const, scope: { accountId, machineId }, title: 'Prepare', createdAt: 1, cancellation: 'supported' as const,
    domainRef: { kind: 'projectCommand' as const, purpose: 'setup' as const, serverId: 'home', machineId,
      workspaceRefId: 'workspace', cwd: '/repo' } };
  const target = { key: 'command', serverId: 'home', machineId, operationId: operation.operationId };
  const reviewOutput = { operation: { ...operation, revision: 2, setupReview: { ...pending,
    kind: 'pendingApproval' as const, code: 'project_setup_consent_required' as const, reviewedEffect: { commands: [] } } } };
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
    { kind: 'action', id: 'prepare', actionId: 'projects.prepare', input: {}, pauseForReview: true },
  ] };
  const spec = getActionSpec('projects.prepare');
  if (!spec.outputSchema || !spec.completion) throw new Error('Project preparation requires an output completion contract');
  const kit = createWorkflowRunStorageTestkit({ accountId, runId, machineId, now, origin: { kind: 'direct' },
    acceptedEnvelope: directAcceptedEnvelope({ definition, materializedLeaves: [{ sourceKey: '$root', blockId: 'prepare',
      kind: 'action', actionId: 'projects.prepare', selection: {}, executionTarget: { kind: 'session' }, authoredWorkspace: { kind: 'inherit' },
      actionInput: input, actionContract: {
        inputSchema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(spec.inputSchema, { target: 'draft-7' })),
        outputSchema: normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(spec.outputSchema, { target: 'draft-7' })),
        completion: freezeActionCompletionContractV1(spec.completion),
      } }] }) });
  const seal = (id: string, root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
    binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id,
      sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
    progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'action',
      invocationPath: { blockId: root ? '$root' : 'prepare', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
      ...(root ? {} : { reason: { code: pending.code }, execution: { kind: 'action' as const, actionId: 'projects.prepare',
        actionRequestId: 'original', localInputId: 'original', input,
        output: scenario === 'retained' ? pending : { operation }, ...(scenario === 'observed' ? { awaitedOperations: [target] } : {}) } }) },
  }));
  await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(),
    rootInvocation: { id: rootId, contentEnvelope: seal(rootId, true) } });
  await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpointEnvelope(),
    invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: scenario === 'retained' ? 'needs_attention' : 'running', contentEnvelope: seal(childId, false) }] });
  const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run: kit.run(), parentAttempt: 0, storage: kit,
    encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
  const held = await writer.readInvocation(childId);
  if (!held) throw new Error('fixture_invocation_unavailable');
  if (scenario === 'retained') expect(await writer.commitObservation(held, { kind: 'completed', result: pending })).toBeNull();
  else expect(await writer.commitObservation(held, { kind: 'unresolved', code: pending.code, setupConsentOutput: reviewOutput }))
    .toMatchObject({ lifecycle: 'needs_attention' });
  expect(kit.rowById(childId)?.index.lifecycle).toBe('needs_attention');
  expect((await writer.readInvocation(childId))?.progress).toMatchObject({ execution: { input, actionRequestId: 'original',
    output: scenario === 'retained' ? pending : reviewOutput, ...(scenario === 'observed' ? { awaitedOperations: [target] } : {}) } });
  expect((await writer.readInvocation(childId))?.progress.result).toBeUndefined();
  expect((await writer.readInvocation(childId))?.progress.review).toBeUndefined();
});

it('refreshes the encrypted root counts after interrupted native reattach without completing the parent', async () => {
  const rootId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
  const childId = '33333333-3333-4333-8333-333333333333';
  const kit = createWorkflowRunStorageTestkit({ accountId, runId, machineId, now, origin: { kind: 'direct' },
    acceptedEnvelope: directAcceptedEnvelope() });
  const seal = (id: string, root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
    mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id,
      sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
    progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'step',
      invocationPath: { blockId: root ? '$root' : 'step', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
      ...(root ? { stepProgress: { completed: 0, total: 1 } }
        : { execution: { kind: 'session' as const, sessionId: 'session', localInputId: 'input' } }) },
  }));
  await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(),
    rootInvocation: { id: rootId, contentEnvelope: seal(rootId, true) } });
  await kit.execute({ operation: 'invocations.fact', runId, parentAttempt: 0, invocationId: rootId,
    invocationAttempt: '0', expectedContentRevision: '0', expectedLifecycle: 'pending', lifecycle: 'running', contentEnvelope: seal(rootId, true) });
  await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpointEnvelope(),
    invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'running', contentEnvelope: seal(childId, false) }] });
  await kit.execute({ operation: 'transition', runId, expectedRevision: 2, state: 'interrupted', checkpointEnvelope: checkpointEnvelope() });
  const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run: kit.run(), expectedRevision: 3, storage: kit,
    encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
  const child = await writer.readInvocation(childId);
  if (!child) throw new Error('fixture_invocation_unavailable');
  await writer.commitObservation(child, { kind: 'completed', result: 'done' });
  expect((await writer.readInvocation(rootId))?.progress.stepProgress).toEqual({ completed: 1, total: 1 });
  expect(kit.rowById(rootId)?.index.lifecycle).toBe('running');
  expect(kit.run()).toMatchObject({ state: 'interrupted', revision: 3, workflowCustodyState: 'pending' });
  expect(kit.calls.find((operation) => operation.resolution === 'root_list_progress'))
    .toMatchObject({ expectedRevision: 3, invocationId: rootId, expectedLifecycle: 'running', lifecycle: 'running' });
});

it.each([
  { generation: true, kind: 'unresolved', code: 'session_input_pending', lifecycle: 'running' },
  // A pending stop cannot resolve outcome uncertainty; storage requires definitive terminal evidence.
  { generation: true, kind: 'unresolved', code: 'session_input_pending', lifecycle: 'outcome_uncertain', initialLifecycle: 'outcome_uncertain' },
  { generation: true, kind: 'cancelled', code: 'provider_stopped', lifecycle: 'waiting_for_review' },
  { generation: true, kind: 'failed', code: 'provider_failed', lifecycle: 'waiting_for_review' },
  { generation: true, kind: 'completed', lifecycle: 'completed' },
  { generation: false, kind: 'failed', code: 'provider_failed', lifecycle: 'failed' },
] as const)('preserves recovered review input custody ($kind/$code, generation=$generation, from=$initialLifecycle)', async (scenario) => {
  const rootId = '33333333-3333-4333-8333-333333333333';
  const priorId = '22222222-2222-4222-8222-222222222222';
  const recordId = '44444444-4444-4444-8444-444444444444';
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'step', id: 'step', pauseForReview: true,
    document: { text: 'Draft', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] };
  const kit = createWorkflowRunStorageTestkit({ runId, machineId, now, state: 'running', origin: { kind: 'direct' },
    acceptedEnvelope: directAcceptedEnvelope({ definition }) });
  const seal = (id: string, sequence: string, parentRecordId: string | null, progress: WorkflowProgressEnvelopeV1) =>
    serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id, sequence, parentRecordId,
        memberOrdinal: '0', attempt: progress.attempt }, progress }));
  const checkpoint = checkpointEnvelope(rootId);
  await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpoint,
    rootInvocation: { id: rootId, contentEnvelope: seal(rootId, '0', null, { kind: 'happier.workflow-progress.v1', blockKind: 'root',
      invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: rootId }) } });
  await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpoint,
    invocations: [
      { id: priorId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'superseded',
        contentEnvelope: seal(priorId, '1', rootId, { kind: 'happier.workflow-progress.v1', blockKind: 'step',
          invocationPath: { blockId: 'step', scope: [] }, attempt: '0', logicalInvocationRecordId: priorId, result: 'prior',
          ...(scenario.generation ? { review: { decision: { kind: 'generate', requestedFromContentRevision: '0' } } } : {}) }) },
      { id: recordId, sequence: '2', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'running',
        contentEnvelope: seal(recordId, '2', rootId, { kind: 'happier.workflow-progress.v1', blockKind: 'step',
          invocationPath: { blockId: 'step', scope: [] }, attempt: '1', logicalInvocationRecordId: priorId, previousAttemptRecordId: priorId,
          execution: { kind: 'session', sessionId: 'session', localInputId: 'generation-input' } }) },
    ] });
  // Seed the retained replacement row through the canonical storage boundary fixture.
  const replacement = kit.rowById(recordId)!;
  replacement.index = { ...replacement.index, attempt: '1',
    lifecycle: scenario.lifecycle === 'outcome_uncertain' ? scenario.initialLifecycle : 'running' };
  let reviewEntries = 0;
  const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run: kit.run(), parentAttempt: 0, storage: kit,
    encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
    onReviewEntered: async () => { reviewEntries += 1; } });
  const invocation = await writer.readInvocation(recordId);
  if (!invocation) throw new Error('fixture_invocation_unavailable');
  await writer.commitObservation(invocation, scenario.kind === 'completed' ? { kind: 'completed', result: 'generated' }
    : { kind: scenario.kind, code: scenario.code });
  expect(kit.rowById(recordId)?.index.lifecycle).toBe(scenario.lifecycle);
  expect(reviewEntries).toBe(scenario.lifecycle === 'waiting_for_review' ? 1 : 0);
  if (scenario.kind === 'unresolved') {
    expect((await writer.readInvocation(recordId))?.progress.uncertainPriorEffects).toBeUndefined();
  }
  expect(kit.run().workflowCustodyState).toBe('pending');
});

it('reapplies a recovered terminal fact after concurrent publication and enters review with the published value', async () => {
  const recordId = '22222222-2222-4222-8222-222222222222';
  const rootId = '33333333-3333-4333-8333-333333333333';
  const run = WorkflowRunSummaryV1Schema.parse({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'running', revision: 2,
    machineId, workflowCustodyState: 'pending', originDeliveryAckRevision: null, availability, createdAt: now, updatedAt: now });
  let index: WorkflowRunInvocationIndexV1 = { id: recordId, runId, sequence: '1', parentRecordId: rootId,
    memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'running', createdAt: now, updatedAt: now };
  const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId, recordId,
    sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0' };
  let progress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'step',
    invocationPath: { blockId: 'step', scope: [] }, attempt: '0', logicalInvocationRecordId: recordId,
    execution: { kind: 'session', sessionId: 'session', localInputId: 'input' } };
  const seal = () => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding, progress }));
  let envelope = seal();
  let facts = 0;
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'step', id: 'step', pauseForReview: true,
    document: { text: 'Draft', references: [], attachments: [] }, input: [], result: { kind: 'json', schema: { type: 'object', required: ['answer'] } } }] };
  const rootIndex = { ...index, id: rootId, sequence: '0', parentRecordId: null };
  const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
    binding: { ...binding, recordId: rootId, sequence: '0', parentRecordId: null }, progress: { kind: 'happier.workflow-progress.v1',
      blockKind: 'root', invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: rootId } }));
  const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run, parentAttempt: 0,
    encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
    storage: { execute: async (operation) => {
      if (operation.operation === 'get') return { run, acceptedEnvelope: directAcceptedEnvelope({ definition }) };
      if (operation.operation === 'invocations.get') return { invocation: operation.invocationId === rootId
        ? { index: rootIndex, contentEnvelope: rootEnvelope } : { index, contentEnvelope: envelope } };
      if (operation.operation !== 'invocations.fact') throw new Error('unexpected_operation');
      facts += 1;
      if (facts === 1) {
        progress = { ...progress, result: { answer: 42 }, review: { resultSource: { kind: 'published', by: 'agent' } } };
        index = { ...index, contentRevision: '1' }; envelope = seal();
        throw Object.assign(new Error('currentness_conflict'), { response: { status: 409 } });
      }
      expect(operation.expectedContentRevision).toBe(index.contentRevision);
      const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
        envelope: parseWorkflowStoredContentEnvelopeV1(operation.contentEnvelope) });
      if (opened.kind !== 'available') throw new Error('fixture_content_unavailable');
      progress = opened.content;
      index = { ...index, lifecycle: operation.lifecycle as WorkflowRunInvocationIndexV1['lifecycle'],
        contentRevision: (BigInt(index.contentRevision) + 1n).toString() };
      envelope = String(operation.contentEnvelope);
      return index;
    } },
  });
  const invocation = await writer.readInvocation(recordId);
  if (!invocation) throw new Error('fixture_content_unavailable');
  await writer.commitObservation(invocation, { kind: 'completed', result: 'Here is the plan.' });
  expect(index.lifecycle).toBe('waiting_for_review');
  expect(progress.result).toEqual({ answer: 42 });
  expect(progress.review?.resultSource).toEqual({ kind: 'published', by: 'agent' });
  expect(progress.execution).toEqual({ kind: 'session', sessionId: 'session', localInputId: 'input' });
});

it.each(['step', 'action'] as const)('reattach decodes the frozen %s JSON contract and settles only the exact row without creating parent custody', async (kind) => {
  const recordId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
  const rootId = '33333333-3333-4333-8333-333333333333';
  const run = WorkflowRunSummaryV1Schema.parse({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'interrupted', revision: 2,
    machineId, workflowCustodyState: 'pending', originDeliveryAckRevision: null, availability, createdAt: now, updatedAt: now });
  const index: WorkflowRunInvocationIndexV1 = { id: recordId, runId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0',
    attempt: '0', contentRevision: '0', lifecycle: 'running', createdAt: now, updatedAt: now };
  const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId, recordId,
    sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0' };
  const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
    progress: { kind: 'happier.workflow-progress.v1', blockKind: kind, invocationPath: { blockId: 'step', scope: [] },
      attempt: '0', logicalInvocationRecordId: recordId, resultContract: { kind: 'text' },
      execution: kind === 'step' ? { kind: 'session', sessionId: 'session-1', localInputId: 'input-1' }
        : { kind: 'action', actionId: 'session.goal.set', actionRequestId: 'request', localInputId: 'request', input: {} } },
  }));
  const schema = { type: 'object' as const, required: ['answer'] };
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [kind === 'step' ? { kind: 'step', id: 'step',
    document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'json', schema } }
    : { kind: 'action', id: 'step', actionId: 'session.goal.set', input: {} }] };
  const materializedLeaves: WorkflowMaterializedLeafV1[] | undefined = kind === 'action' ? [{ authoredWorkspace: { kind: 'inherit' as const },
    sourceKey: '$root', blockId: 'step', kind: 'action', selection: {}, executionTarget: { kind: 'session' },
    actionId: 'session.goal.set', actionContract: { inputSchema: {}, outputSchema: schema },
  }] : undefined;
  const operations: Readonly<Record<string, unknown>>[] = [];
  const rootIndex = { ...index, id: rootId, sequence: '0', parentRecordId: null, lifecycle: 'completed' };
  const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
    binding: { ...binding, recordId: rootId, sequence: '0', parentRecordId: null },
    progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] },
      attempt: '0', logicalInvocationRecordId: rootId },
  }));
  const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run,
    encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
    expectedRevision: 2,
    storage: { execute: async (operation) => {
      operations.push(operation);
      if (operation.operation === 'invocations.get') return { invocation: operation.invocationId === rootId
        ? { index: rootIndex, contentEnvelope: rootEnvelope } : { index, contentEnvelope } };
      if (operation.operation === 'get') return { run, acceptedEnvelope: directAcceptedEnvelope({ definition, materializedLeaves }) };
      if (operation.operation === 'invocations.fact') return {};
      throw new Error('unexpected_replacement_or_claim');
    } },
  });
  const invocation = await writer.readInvocation(recordId);
  if (!invocation) throw new Error('fixture_invocation_unavailable');
  expect(await writer.commitObservation(invocation, { kind: 'completed', result: kind === 'step' ? '{"answer":42}' : { answer: 42 } }))
    .toMatchObject({ id: recordId, lifecycle: 'completed' });
  const fact = operations.find((operation) => operation.operation === 'invocations.fact')!;
  expect(fact).toMatchObject({ expectedRevision: 2, resolution: 'observed_terminal_execution', invocationId: recordId,
    invocationAttempt: '0', expectedLifecycle: 'running', lifecycle: 'completed' });
  expect(fact).not.toHaveProperty('parentAttempt');
  const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
    envelope: parseWorkflowStoredContentEnvelopeV1(fact.contentEnvelope) });
  expect(opened.kind === 'available' ? opened.content.result : undefined).toEqual({ answer: 42 });
  expect(operations.some((operation) => operation.operation === 'invocations.admit' || operation.operation === 'initialize')).toBe(false);
});

function isPlainAccountCurrentness(value: unknown): boolean {
  return value !== null && typeof value === 'object' && 'mode' in value && value.mode === 'plain';
}

function directAcceptedEnvelope(params: Readonly<{
  definition?: WorkflowDefinitionV1;
  materializedLeaves?: WorkflowMaterializedLeafV1[];
  sealMode?: { mode: 'plain' } | Pick<Extract<Parameters<typeof sealWorkflowAcceptedSnapshotStoredEnvelopeV1>[0], { mode: 'e2ee' }>, 'mode' | 'runDataKey' | 'randomBytes'>;
}> = {}) {
  const definition: WorkflowDefinitionV1 = params.definition ?? { version: 1, inputs: [], defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'agent.test', localId: 'test' } } }, blocks: [{
    kind: 'step', id: 'step', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' },
  }] };
  return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
    ...(params.sealMode ?? { mode: 'plain' as const }),
    binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
    acceptedSnapshot: {
      startedBy: 'user', definition, authoredDefinition: definition, workDepth: 0, metadata: null, frozenChildren: {},
      materializedLeaves: params.materializedLeaves ?? [{ sourceKey: '$root', blockId: 'step', kind: 'step',
        authoredWorkspace: { kind: 'inherit' }, selection: definition.defaults, executionTarget: { kind: 'session' } }],
      source: { kind: 'inline' }, inputs: {}, machineId,
      executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo', workspaceRefId: 'workspace-1' }, originalCommittedRevision: 'a'.repeat(40) },
      origin: { kind: 'direct', originSessionId: 'session-origin' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      resultDelivery: { kind: 'originating_session', originSessionId: 'session-origin' },
    },
  }));
}

function checkpointEnvelope(rootRecordId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c') {
  return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
    mode: 'plain',
    binding: { v: 1, purpose: 'checkpoint', accountId, runId },
    checkpoint: {
      kind: 'happier.workflow-checkpoint.v1',
      rootRecordId,
      nextSequence: '8',
      frontier: { nextBlockOrdinal: 1, paused: false },
    },
  }));
}

describe.each(['plain', 'e2ee'] as const)('frozen result recovery (%s)', (mode) => {
  const cases: readonly Readonly<{
    name: string;
    contract: WorkflowStep['result'];
    observed: SessionInputResultV1 | { kind: 'typed'; value: JsonValue };
    expected: Pick<WorkflowProgressEnvelopeV1, 'result' | 'reason'>;
    lifecycle: 'completed' | 'failed' | 'cancelled';
  }>[] = [
    { name: 'successful no-text', contract: { kind: 'text' },
      observed: { kind: 'terminal_no_result', reason: 'missing_final_assistant_text', usage: { inputTokens: 8 } },
      expected: { result: '' }, lifecycle: 'completed' },
    { name: 'raw JSON at the selected nested leaf', contract: { kind: 'json', schema: { type: 'object', required: ['answer'] } },
      observed: { kind: 'final_text', text: '{"answer":42}', usage: { inputTokens: 8 } },
      expected: { result: { answer: 42 } }, lifecycle: 'completed' },
    { name: 'typed JSON string without reparsing', contract: { kind: 'json', schema: { type: 'string' } },
      observed: { kind: 'typed', value: '{"answer":42}' },
      expected: { result: '{"answer":42}' }, lifecycle: 'completed' },
    { name: 'missing required JSON output', contract: { kind: 'json', schema: {} },
      observed: { kind: 'terminal_no_result', reason: 'missing_final_assistant_text', usage: { inputTokens: 8 } },
      expected: { reason: { code: 'invalid_result_contract', message: 'not_json' } }, lifecycle: 'failed' },
    { name: 'missing permitted decision', contract: { kind: 'decision', decisions: ['continue', 'stop'] },
      observed: { kind: 'terminal_no_result', reason: 'missing_final_assistant_text', usage: { inputTokens: 8 } },
      expected: { reason: { code: 'invalid_result_contract', message: 'not_json' } }, lifecycle: 'failed' },
    { name: 'failed input is not successful no-text', contract: { kind: 'text' },
      observed: { kind: 'failed', message: 'provider failed', usage: { inputTokens: 8 } },
      expected: { reason: { code: 'session_input_failed', message: 'provider failed' } }, lifecycle: 'failed' },
    { name: 'cancelled exact input retains usage', contract: { kind: 'text' },
      observed: { kind: 'cancelled', message: 'input cancelled', usage: { inputTokens: 8 } },
      expected: { reason: { code: 'session_input_cancelled' } }, lifecycle: 'cancelled' },
  ];

  async function recoverResult(test: (typeof cases)[number], options: Readonly<{
    acceptedAvailable?: boolean;
    observationAvailable?: boolean;
    initialReason?: WorkflowProgressEnvelopeV1['reason'];
  }> = {}) {
    const material = mode === 'e2ee' ? createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    }) : undefined;
    const encryption: AvailableAutomationAccountEncryptionV1 = mode === 'plain'
      ? { kind: 'available', witness: { mode, version: 1, contentKeyFingerprint: null } }
      : { kind: 'available', witness: { mode, version: 1, contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material!.contentPublicKeyFingerprint) }, material: material! };
    const prepared = prepareWorkflowRunDataKeyV1({ accountId, encryption, randomBytes: (length: number) => new Uint8Array(length).fill(3) });
    const sealMode = prepared.runCrypto.mode === 'plain' ? prepared.runCrypto
      : { ...prepared.runCrypto, randomBytes: (length: number) => new Uint8Array(length).fill(3) };
    const ownerEnvelope = prepared.recipientKeyEnvelopes[0]?.encryptedDataKey ?? null;
    const rootId = '1aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const parentId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const leafId = '3aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const leaf: WorkflowStep = { kind: 'step', id: 'shared', document: { text: 'Work', references: [], attachments: [] }, input: [], result: test.contract };
    // Both branches deliberately reuse an id. Recovery must follow the stored
    // structural slot, not the first global match or the row's display contract.
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{
      kind: 'if', id: 'choice', when: { kind: 'exists', value: { kind: 'literal', value: true } },
      then: [{ ...leaf, result: { kind: 'text' } }], otherwise: [leaf],
    }] };
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, origin: { kind: 'direct' },
      keyCensus: { runId, ownerAccountId: accountId, access: 'owner', visibleTeamId: null, encryptionMode: mode,
        ownerAccountCurrentness: encryption.witness, dataEncryptionKey: ownerEnvelope,
        callerDataEncryptionKey: ownerEnvelope, recipients: [] },
      acceptedEnvelope: options.acceptedAvailable !== false ? directAcceptedEnvelope({ definition, sealMode }) : 'unavailable' });
    const checkpoint = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
      ...sealMode, binding: { v: 1, purpose: 'checkpoint', accountId, runId },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '3', frontier: { nextBlockOrdinal: 1, paused: false } },
    }));
    const sealRow = (index: Pick<WorkflowRunInvocationIndexV1, 'id' | 'sequence' | 'parentRecordId' | 'memberOrdinal'>, progress: WorkflowProgressEnvelopeV1) =>
      serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...sealMode,
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: index.id,
          sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: '0' }, progress }));
    const root = { id: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0' };
    const parent = { id: parentId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0' };
    const child = { id: leafId, sequence: '2', parentRecordId: parentId, memberOrdinal: '0' };
    const rootEnvelope = sealRow(root, { kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: rootId });
    await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpoint, rootInvocation: { id: rootId, contentEnvelope: rootEnvelope } });
    await kit.execute({ operation: 'invocations.fact', runId, invocationId: rootId, invocationAttempt: '0',
      expectedContentRevision: kit.rowById(rootId)!.index.contentRevision,
      expectedLifecycle: 'pending', lifecycle: 'completed', contentEnvelope: rootEnvelope });
    await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpoint, invocations: [
      { ...parent, lifecycle: 'completed', contentEnvelope: sealRow(parent, { kind: 'happier.workflow-progress.v1', blockKind: 'if', invocationPath: { blockId: 'choice', scope: [] },
        container: { kind: 'if', selected: 'otherwise', nextBlockOrdinal: '0' }, attempt: '0', logicalInvocationRecordId: parentId }) },
      { ...child, lifecycle: options.initialReason ? 'needs_attention' : 'running', contentEnvelope: sealRow(child, { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'shared', scope: [] },
        attempt: '0', logicalInvocationRecordId: leafId, resultContract: { kind: 'text' },
        ...(options.initialReason ? { reason: options.initialReason } : {}),
        execution: test.observed.kind === 'typed' ? { kind: 'detached_run', runId: 'execution-1', localInputId: 'input-1', runtimeSelection: {} }
          : { kind: 'session', sessionId: 'session-1', localInputId: 'input-1' } }) },
    ] });
    await kit.execute({ operation: 'transition', runId, expectedRevision: 2, state: 'failed', checkpointEnvelope: checkpoint });
    const seeded = kit.calls.length;
    const observeSession = vi.fn(async () => {
      if (test.observed.kind === 'typed') throw new Error('wrong_execution_correspondence');
      if (options.observationAvailable === false) return { ok: false as const, code: 'session_not_found' as const };
      return { ok: true as const, sessionId: 'session-1', localId: 'input-1', result: test.observed };
    });
    const observer = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId,
      observeSession, cancelSession: async () => { throw new Error('terminal_input_must_not_be_cancelled'); },
      actionExecutor: { execute: async () => ({ ok: true as const, result: { run: {
        runId: 'execution-1', callId: 'call-1', sidechainId: 'sidechain-1', intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response', status: 'running', startedAtMs: 1,
        inputTurns: { occurrenceId: 'occurrence-1', last: { turnId: 'turn-1', inputIds: ['input-1'], state: 'completed',
          result: { kind: 'json', value: test.observed.kind === 'typed' ? test.observed.value : null } } },
      } } }) },
    });
    await createWorkflowRunRecoveryReader({ accountId, machineId,
      storage: { execute: async (operation, options) => operation.operation === 'recovery.list'
        ? { candidates: [{ run: kit.run(), parentAttempt: 1 }] } : await kit.execute(operation, options) },
      resolveAccountEncryption: async () => encryption, reconcileInvocation: observer,
    })('reconnect');
    const row = kit.rowById(leafId)!;
    const opened = openWorkflowProgressStoredEnvelopeV1({ ...prepared.runCrypto,
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: leafId,
        sequence: '2', parentRecordId: parentId, memberOrdinal: '0', attempt: '0' },
      envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope) });
    if (opened.kind !== 'available') throw new Error('recovered_row_unavailable');
    expect(kit.run().state).toBe('failed');
    expect(kit.calls.slice(seeded).some((operation) => operation.operation === 'initialize' || operation.operation === 'invocations.admit')).toBe(false);
    return { lifecycle: row.index.lifecycle, progress: opened.content, custody: kit.run().workflowCustodyState, observeSession };
  }

  it.each(cases)('$name retains exact custody and validates the frozen contract', async (test) => {
    const recovered = await recoverResult(test);
    expect(recovered.lifecycle).toBe(test.lifecycle);
    expect(recovered.progress.result).toEqual(test.expected.result);
    expect(recovered.progress.reason).toEqual(test.expected.reason);
    expect(recovered.progress.usage).toEqual(test.observed.kind === 'typed' ? undefined : { inputTokens: 8 });
    expect(recovered.custody).toBe('settled');
    if (test.observed.kind !== 'typed') expect(recovered.observeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', localId: 'input-1' }));
  });

  it('keeps completion unresolved when the accepted contract cannot be opened', async () => {
    const recovered = await recoverResult(cases[1]!, { acceptedAvailable: false });
    expect(recovered.lifecycle).toBe('running');
    expect(recovered.progress.result).toBeUndefined();
    expect(recovered.custody).toBe('pending');
  });

  it('settles a terminal provider failure while preserving the previously published timeout reason', async () => {
    const failedInput = cases.find((test) => test.observed.kind === 'failed');
    if (!failedInput) throw new Error('missing_failed_input_fixture');
    const initialReason = { code: 'workflow_step_timeout' };
    const recovered = await recoverResult(failedInput, { initialReason });
    expect(recovered.lifecycle).toBe('failed');
    expect(recovered.progress.reason).toEqual(initialReason);
    expect(recovered.progress.result).toBeUndefined();
    expect(recovered.progress.usage).toEqual({ inputTokens: 8 });
    expect(recovered.custody).toBe('settled');
  });

  it('does not turn an unavailable exact Session into successful empty text', async () => {
    const recovered = await recoverResult(cases[0]!, { observationAvailable: false });
    expect(recovered.lifecycle).toBe('running');
    expect(recovered.progress.result).toBeUndefined();
    expect(recovered.custody).toBe('pending');
  });
});

describe('workflow Run startup/reconnect recovery', () => {
  it.each(['cancelled_input', 'other_input', 'handled_input', 'unknown_launch'] as const)('recovers exact discarded Session input custody without treating inactive or unknown work as stopped (%s)', async scenario => {
    const rootId = '33333333-3333-4333-8333-333333333333';
    const childId = '44444444-4444-4444-8444-444444444444';
    const sessionId = 'stopped-workflow-session';
    const localId = 'exact-workflow-input';
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, now, origin: { kind: 'direct' },
      acceptedEnvelope: directAcceptedEnvelope() });
    const seal = (id: string, root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id,
        sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'step',
        invocationPath: { blockId: root ? '$root' : 'step', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
        ...(!root && scenario !== 'unknown_launch' ? { execution: { kind: 'session' as const, sessionId, localInputId: localId } } : {}) },
    }));
    await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(rootId),
      rootInvocation: { id: rootId, contentEnvelope: seal(rootId, true) } });
    await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpointEnvelope(rootId),
      invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'running', contentEnvelope: seal(childId, false) }] });
    kit.requestControl('cancelled');
    expect(kit.run()).toMatchObject({ workflowCustodyState: 'pending', attentionRequired: true });
    const requests: { method: string; path: string }[] = [];
    // Real HTTP readers consume the same tombstone shape as the retained Home.
    // Only the Home/storage and socket transports are substituted.
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      requests.push({ method: request.method ?? '', path: url.pathname });
      response.setHeader('Content-Type', 'application/json');
      const reply = (data: unknown, status = 200) => { response.statusCode = status; response.end(JSON.stringify(data)); };
      if (url.pathname === '/v1/account/encryption/currentness') return reply({
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      });
      if (url.pathname === `/v2/sessions/${sessionId}`) return reply({ session: createSessionRecordFixture({
        id: sessionId, active: false, encryptionMode: 'plain', machineId,
        metadata: JSON.stringify({ machineId, path: '/repo' }),
      }) });
      if (url.pathname.startsWith(`/v2/sessions/${sessionId}/messages/by-local-id/`)) return reply({ error: 'Message not found' }, 404);
      if (url.pathname === `/v2/sessions/${sessionId}/pending` && request.method === 'GET') {
        return reply({ pending: url.searchParams.get('includeDiscarded') === 'true' ? [{
          localId: scenario === 'other_input' ? 'different-input' : localId,
          status: 'discarded', deliveryStatus: { status: 'discarded', reason: scenario === 'handled_input' ? 'manual_handled' : 'session_input_cancelled' }, discardedAt: 1,
        }] : [] });
      }
      return reply({ error: 'session-not-found' }, 404);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test_http_address_unavailable');
    const socketBoundary = vi.spyOn(sessionSockets, 'createSessionScopedSocketConnection').mockImplementation(() => {
      // This fixture represents the untyped socket.io network adapter, not its host observer.
      const socket = Object.assign(new EventEmitter(), { connected: false, connect() {}, disconnect() {}, close() {} }) as unknown as ReturnType<typeof sessionSockets.createSessionScopedSocketConnection>['socket'];
      return { socket, transport: createSocketTransportAdapter(socket) };
    });
    try {
      const observe = createWorkflowInvocationRecoveryObserver({
        credentials: { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null }, machineId,
        actionExecutor: { execute: async () => { throw new Error('Recovery cannot start an Action'); } },
      });
      const recover = createWorkflowRunRecoveryReader({ accountId, machineId,
        storage: { execute: async (operation, options) => operation.operation === 'recovery.list'
          ? { candidates: [{ run: kit.run(), parentAttempt: 0 }] } : await kit.execute(operation, options) },
        resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        reconcileInvocation: observe,
      });
      await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () => recover('startup'));
      const cancelled = scenario === 'cancelled_input';
      if (scenario !== 'unknown_launch') expect(requests).toContainEqual({ method: 'GET', path: `/v2/sessions/${sessionId}/pending` });
      expect(kit.rowById(childId)?.index.lifecycle).toBe(cancelled ? 'cancelled' : 'cancel_requested');
      expect(kit.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: cancelled ? 'settled' : 'pending', attentionRequired: !cancelled });
      if (cancelled) expect(requests.every(request => request.method === 'GET')).toBe(true);
      if (scenario === 'unknown_launch') expect(requests).toEqual([]);
    } finally {
      socketBoundary.mockRestore();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each(['later', 'before_observation', 'running_parent', 'lost_stop_response'] as const)('settles stopped Action child custody when terminal arrives %s without another recovery trigger', async (timing) => {
    const rootId = '33333333-3333-4333-8333-333333333333';
    const childId = '44444444-4444-4444-8444-444444444444';
    const completion = freezeActionCompletionContractV1(getActionSpec('review.start').completion!);
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {},
      blocks: [{ kind: 'action', id: 'review', actionId: 'review.start', input: {} }] };
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, now, origin: { kind: 'direct' },
      acceptedEnvelope: directAcceptedEnvelope({ definition, materializedLeaves: [{ sourceKey: '$root', blockId: 'review',
        kind: 'action', actionId: 'review.start', selection: {}, executionTarget: { kind: 'detached_run' },
        authoredWorkspace: { kind: 'inherit' }, actionContract: { inputSchema: {}, outputSchema: {}, completion } }] }) });
    const seal = (id: string, root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id,
        sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'action',
        invocationPath: { blockId: root ? '$root' : 'review', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
        ...(root ? {} : { execution: { kind: 'action' as const, actionId: 'review.start', actionRequestId: 'request', localInputId: 'request', input: {},
          output: { intent: 'review', sessionId: null, results: [{ key: 'codex', ok: true, result: { runId: 'native-review' } }] },
          awaitedRuns: [{ key: 'codex', runId: 'native-review' }] } }) },
    }));
    await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpointEnvelope(rootId),
      rootInvocation: { id: rootId, contentEnvelope: seal(rootId, true) } });
    await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpointEnvelope(rootId),
      invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'running', contentEnvelope: seal(childId, false) }] });
    kit.requestControl(timing === 'running_parent' ? 'cancel_requested' : 'cancelled');
    let terminal = false;
    let finish = () => {};
    const terminalEvent = new Promise<void>((resolve) => { finish = () => { terminal = true; resolve(); }; });
    const snapshot = () => ({ run: { runId: 'native-review', callId: 'call', sidechainId: 'side', intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'default', retentionPolicy: 'resumable',
      runClass: 'bounded', ioMode: 'request_response', status: terminal ? 'succeeded' : 'running', startedAtMs: 1 },
      ...(terminal ? { latestToolResult: { findings: [], reviewedFingerprint: 'fingerprint', commentIds: ['comment'], materialization: { kind: 'complete' } } } : {}) });
    const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId,
      actionExecutor: { execute: async () => { throw new Error('unexpected_action_effect'); } },
      nativeActionRuns: { get: async () => snapshot(), stop: async () => {
        if (timing === 'before_observation') finish();
        if (timing === 'lost_stop_response') throw new Error('stop_response_lost');
        return { ok: true };
      },
        wait: async () => { await terminalEvent; return snapshot(); } } });
    let indexed = false;
    const recover = createWorkflowRunRecoveryReader({ accountId, machineId,
      storage: { execute: async (operation, options) => {
        if (operation.operation !== 'recovery.list') return await kit.execute(operation, options);
        // The completion wake must not launch another global sweep.
        if (indexed) throw new Error('unexpected_global_recovery_sweep');
        indexed = true;
        return { candidates: [{ run: kit.run(), parentAttempt: 0 }] };
      } },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation: observe });
    await recover('startup');
    if (timing !== 'before_observation') {
      expect(kit.run().workflowCustodyState).toBe('pending');
      expect(kit.rowById(childId)?.index.lifecycle).toBe('cancel_requested');
      finish();
    }
    await vi.waitFor(() => expect(kit.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'settled' }));
    const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run: kit.run(), parentAttempt: 0, storage: kit,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
    expect((await writer.readInvocation(childId))?.progress.result).toMatchObject({ commentIds: ['comment'],
      perEngineOutcome: [{ key: 'codex', runId: 'native-review', outcome: 'completed' }] });
    expect(kit.rowById(childId)?.index.lifecycle).toBe('completed');
  });

  it('pages terminal candidates and settles custody while origin updates remain unacknowledged', async () => {
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' as const, originSessionId: 'session-origin' }, state: 'succeeded' as const,
      revision: 9, machineId, workflowCustodyState: 'pending' as const, originDeliveryAckRevision: 0,
      availability, createdAt: now, updatedAt: now };
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'recovery.list') return operation.cursor
        ? { candidates: [] } : { candidates: [{ run, parentAttempt: 3 }], nextCursor: 'page-2' };
      if (operation.operation === 'run-key.census') return createPlainWorkflowRunKeyCensusFixture({ runId, accountId });
      if (operation.operation === 'invocations.list') return { invocations: [], parentRevision: 9 };
      if (operation.operation === 'get') return { run, checkpointEnvelope: checkpointEnvelope() };
      if (operation.operation === 'transition') return { ...run, revision: 10, workflowCustodyState: 'settled' };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const recover = createWorkflowRunRecoveryReader({
      accountId, machineId, storage: { execute },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation: vi.fn(async () => ({ kind: 'unresolved' as const })),
    });
    await recover('startup');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'transition', runId, parentAttempt: 3, expectedRevision: 9, state: 'succeeded', custodyState: 'settled',
    }), {});
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'recovery.list' && operation.cursor === 'page-2')).toBe(true);
  });

  it('opens only lifecycle-selected invocation rows and never coordinates or starts terminal parents', async () => {
    const invocationId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const rootId = '33333333-3333-4333-8333-333333333333';
    const completedId = '44444444-4444-4444-8444-444444444444';
    const root = { id: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0' };
    const child = { id: invocationId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0' };
    const completed = { id: completedId, sequence: '2', parentRecordId: rootId, memberOrdinal: '1' };
    const progress = { kind: 'happier.workflow-progress.v1' as const, invocationPath: { blockId: 'work', scope: [] }, blockKind: 'step' as const,
      attempt: '0', logicalInvocationRecordId: invocationId, execution: { kind: 'session' as const, sessionId: 'session-1', localInputId: 'input-1' } };
    const sealRow = (row: Pick<WorkflowRunInvocationIndexV1, 'id' | 'sequence' | 'parentRecordId' | 'memberOrdinal'>, content: WorkflowProgressEnvelopeV1) =>
      serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.id,
          sequence: row.sequence, parentRecordId: row.parentRecordId, memberOrdinal: row.memberOrdinal, attempt: '0' }, progress: content,
      }));
    const checkpoint = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'checkpoint', accountId, runId },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '3',
        frontier: { nextBlockOrdinal: 2, paused: false } },
    }));
    // The real storage-boundary testkit advances lifecycle/contentRevision and
    // sealed bytes together, so settlement rereads observe the committed fact.
    const kit = createWorkflowRunStorageTestkit({ runId, machineId, now,
      origin: { kind: 'automation', automationId: 'automation-1' }, invocationPageSize: 1,
      acceptedEnvelope: directAcceptedEnvelope({ definition: { version: 1, inputs: [], defaults: {}, blocks: [
        { kind: 'step', id: 'work', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        { kind: 'step', id: 'finished', document: { text: 'Finished', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      ] } }),
    });
    await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: checkpoint,
      rootInvocation: { id: rootId, contentEnvelope: sealRow(root, { kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId }) },
    });
    await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope: checkpoint,
      invocations: [{ ...child, lifecycle: 'running', contentEnvelope: sealRow(child, progress) },
        { ...completed, lifecycle: 'completed', contentEnvelope: sealRow(completed, { kind: 'happier.workflow-progress.v1',
          invocationPath: { blockId: 'finished', scope: [] }, blockKind: 'step', attempt: '0', logicalInvocationRecordId: completedId,
          result: 'already done' }) }],
    });
    kit.requestControl('cancelled');
    const run = kit.run();
    const index = kit.rowById(invocationId)!.index;
    const execute = vi.fn(async (operation: WorkflowRunStorageTestkitOperation, options?: Readonly<{ signal?: AbortSignal }>) => {
      if (operation.operation === 'recovery.list') return { candidates: [{ run, parentAttempt: 2 }] };
      if (operation.operation === 'invocations.list') {
        expect(operation.lifecycles).toEqual(['pending', 'waiting_for_capacity', 'admitting', 'running', 'waiting_for_approval', 'needs_attention', 'cancel_requested', 'outcome_uncertain']);
      }
      return await kit.execute(operation, options);
    });
    const reconcileInvocation = vi.fn(async () => ({ kind: 'cancelled' as const, code: 'provider_stopped' }));
    const recover = createWorkflowRunRecoveryReader({
      accountId, machineId, storage: { execute },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation,
    });

    await recover('reconnect');

    expect(reconcileInvocation).toHaveBeenCalledWith(expect.objectContaining({
      run: expect.objectContaining({ id: run.id, state: run.state, revision: run.revision }),
      index,
      progress,
      terminalParent: true,
      cancellationRequested: true,
      parentAttempt: 2,
      trigger: 'reconnect',
    }));
    const exactReads = execute.mock.calls.filter(([operation]) => operation.operation === 'invocations.get');
    expect(exactReads.length).toBeGreaterThan(0);
    expect(exactReads.every(([operation]) => operation.runId === runId
      && (operation.invocationId === rootId || operation.invocationId === invocationId))).toBe(true);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.list' && operation.cursor !== undefined)).toBe(true);
    const settledIndex = kit.rowById(invocationId)!.index;
    expect(settledIndex).toMatchObject({ lifecycle: 'cancelled', contentRevision: (BigInt(index.contentRevision) + 1n).toString() });
    expect(kit.rowById(completedId)?.index).toMatchObject({ lifecycle: 'completed', contentRevision: '0' });
    expect(kit.run()).toMatchObject({ state: 'cancelled', revision: run.revision + 1, workflowCustodyState: 'settled' });
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.fact'
      && operation.runId === runId && operation.parentAttempt === 2
      && isPlainAccountCurrentness(operation.accountCurrentness)
      && operation.invocationId === invocationId && operation.invocationAttempt === '0'
      && operation.expectedContentRevision === index.contentRevision
      && operation.expectedLifecycle === 'cancel_requested' && operation.lifecycle === 'cancelled')).toBe(true);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'transition'
      && operation.runId === runId && operation.parentAttempt === 2
      && isPlainAccountCurrentness(operation.accountCurrentness)
      && operation.expectedRevision === run.revision && operation.state === 'cancelled'
      && operation.custodyState === 'settled'
      && Array.isArray(operation.invocationTransitions)
      && operation.invocationTransitions.some((transition: Readonly<Record<string, unknown>>) => transition.id === invocationId
        && transition.expectedLifecycle === 'cancelled' && transition.lifecycle === 'cancelled'
        && transition.expectedContentRevision === settledIndex.contentRevision))).toBe(true);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'initialize' || operation.operation === 'invocations.admit')).toBe(false);
  });

  it('rejoins a concurrently settled terminal Run after a custody response loss', async () => {
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' as const, originSessionId: 'session-origin' }, state: 'succeeded' as const,
      revision: 9, machineId, workflowCustodyState: 'pending' as const, originDeliveryAckRevision: 0,
      availability, createdAt: now, updatedAt: now };
    let settled = false;
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'recovery.list') return { candidates: [{ run, parentAttempt: 3 }] };
      if (operation.operation === 'run-key.census') return createPlainWorkflowRunKeyCensusFixture({ runId, accountId });
      if (operation.operation === 'invocations.list') return { invocations: [], parentRevision: 9 };
      if (operation.operation === 'get') return { run: settled
        ? { ...run, revision: 10, workflowCustodyState: 'settled' } : run, checkpointEnvelope: checkpointEnvelope() };
      if (operation.operation === 'transition') { settled = true; throw new Error('response_lost'); }
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const recover = createWorkflowRunRecoveryReader({
      accountId, machineId, storage: { execute },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation: vi.fn(async () => ({ kind: 'unresolved' as const })),
    });
    await expect(recover('reconnect')).resolves.toBeUndefined();
    expect(execute.mock.calls.filter(([operation]) => operation.operation === 'transition')).toHaveLength(1);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'initialize')).toBe(false);
  });

  it('reconciles a terminal structural row without native observation or rewriting its truth', async () => {
    const invocationId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'automation' as const, automationId: 'automation-1' }, state: 'outcome_uncertain' as const,
      revision: 6, machineId, workflowCustodyState: 'pending' as const, originDeliveryAckRevision: null,
      availability, createdAt: now, updatedAt: now };
    const index = { id: invocationId, runId, sequence: '7', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '0', lifecycle: 'outcome_uncertain' as const, createdAt: now, updatedAt: now };
    const progress = { kind: 'happier.workflow-progress.v1' as const, invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root' as const,
      attempt: '0', logicalInvocationRecordId: invocationId,
      result: { retained: true }, reason: { code: 'delivery_ambiguous' } };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationId,
        sequence: '7', parentRecordId: null, memberOrdinal: '0', attempt: '0' }, progress,
    }));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'recovery.list') return { candidates: [{ run, parentAttempt: 4 }] };
      if (operation.operation === 'run-key.census') return createPlainWorkflowRunKeyCensusFixture({ runId, accountId });
      if (operation.operation === 'invocations.list') return { invocations: [index], parentRevision: 6 };
      if (operation.operation === 'invocations.get') return { invocation: { index, contentEnvelope, parentRevision: 6 } };
      if (operation.operation === 'invocations.fact') return { ...index, lifecycle: operation.lifecycle };
      if (operation.operation === 'get') return { run, acceptedEnvelope: directAcceptedEnvelope(), checkpointEnvelope: checkpointEnvelope(), resultEnvelope: null };
      if (operation.operation === 'transition') return { ...run, revision: 7, workflowCustodyState: 'settled' };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const reconcileInvocation = vi.fn(async () => ({ kind: 'unresolved' as const }));
    const recover = createWorkflowRunRecoveryReader({
      accountId, machineId, storage: { execute },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation,
    });

    await recover('startup');

    const fact = execute.mock.calls.find(([operation]) => operation.operation === 'invocations.fact')?.[0];
    expect(fact).toEqual(expect.objectContaining({
      expectedLifecycle: 'outcome_uncertain', lifecycle: 'outcome_uncertain', invocationAttempt: '0',
    }));
    const reopened = parseWorkflowStoredContentEnvelopeV1(fact?.contentEnvelope);
    const learned = reopened && openWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationId,
        sequence: '7', parentRecordId: null, memberOrdinal: '0', attempt: '0' }, envelope: reopened,
    });
    expect(learned?.kind === 'available' ? learned.content : null).toEqual(progress);
    expect(reconcileInvocation).not.toHaveBeenCalled();
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'transition'
      && Array.isArray(operation.invocationTransitions)
      && operation.invocationTransitions.some((transition: Readonly<Record<string, unknown>>) => transition.id === invocationId
        && transition.expectedLifecycle === 'outcome_uncertain' && transition.lifecycle === 'outcome_uncertain'))).toBe(true);
  });

  it('marks an uncertain step retryable only after its exact execution owner proves it stopped', async () => {
    const invocationId = '5aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' as const }, state: 'interrupted' as const,
      revision: 6, machineId, workflowCustodyState: 'pending' as const, originDeliveryAckRevision: null,
      availability, createdAt: now, updatedAt: now };
    const index = { id: invocationId, runId, sequence: '7', parentRecordId: null, memberOrdinal: '0', attempt: '0',
      contentRevision: '0', lifecycle: 'outcome_uncertain' as const, createdAt: now, updatedAt: now };
    const progress = { kind: 'happier.workflow-progress.v1' as const, invocationPath: { blockId: 'work', scope: [] }, blockKind: 'step' as const,
      attempt: '0', logicalInvocationRecordId: invocationId,
      execution: { kind: 'session' as const, sessionId: 'session-1', localInputId: 'input-1' } };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationId,
        sequence: '7', parentRecordId: null, memberOrdinal: '0', attempt: '0' }, progress,
    }));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'recovery.list') return { candidates: [{ run, parentAttempt: 4 }] };
      if (operation.operation === 'run-key.census') return createPlainWorkflowRunKeyCensusFixture({ runId, accountId });
      if (operation.operation === 'invocations.list') return { invocations: [index], parentRevision: 6 };
      if (operation.operation === 'invocations.get') return { invocation: { index, contentEnvelope, parentRevision: 6 } };
      if (operation.operation === 'invocations.fact') return { ...index, lifecycle: operation.lifecycle };
      if (operation.operation === 'get') return { run, acceptedEnvelope: directAcceptedEnvelope(), checkpointEnvelope: checkpointEnvelope(), resultEnvelope: null };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const recover = createWorkflowRunRecoveryReader({
      accountId, machineId, storage: { execute },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation: vi.fn(async () => ({ kind: 'cancelled' as const, code: 'observed_stopped' })),
    });

    await recover('reconnect');

    const fact = execute.mock.calls.find(([operation]) => operation.operation === 'invocations.fact')?.[0];
    expect(fact).toMatchObject({
      expectedLifecycle: 'outcome_uncertain', lifecycle: 'needs_attention', resolution: 'observed_terminal_execution',
    });
    const reopened = parseWorkflowStoredContentEnvelopeV1(fact?.contentEnvelope);
    const resolved = reopened && openWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationId,
        sequence: '7', parentRecordId: null, memberOrdinal: '0', attempt: '0' }, envelope: reopened,
    });
    expect(resolved?.kind === 'available' ? resolved.content : null).toMatchObject({
      uncertainPriorEffects: { activity: 'stopped' }, reason: { code: 'observed_stopped' },
    });
  });

  it('settles a running cancellation through structural and executable row facts before parent custody', async () => {
    const rootId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const childId = '5ebde945-7386-438c-9bc0-12f1f7c76e76';
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'automation' as const, automationId: 'automation-1' }, state: 'running' as const,
      revision: 8, machineId, workflowCustodyState: 'pending' as const, originDeliveryAckRevision: null,
      availability, createdAt: now, updatedAt: now };
    const indexes = [
      { id: rootId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'cancel_requested' as const, createdAt: now, updatedAt: now },
      { id: childId, runId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'cancel_requested' as const, createdAt: now, updatedAt: now },
    ];
    const progresses = [
      { kind: 'happier.workflow-progress.v1' as const, invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root' as const,
        attempt: '0', logicalInvocationRecordId: rootId },
      { kind: 'happier.workflow-progress.v1' as const, invocationPath: { blockId: 'step', scope: [] }, blockKind: 'step' as const,
        attempt: '0', logicalInvocationRecordId: childId,
        execution: { kind: 'session' as const, sessionId: 'session-1', localInputId: 'input-1' } },
    ];
    const envelopes = indexes.map((index, ordinal) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: index.id,
        sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: '0', attempt: '0' }, progress: progresses[ordinal]!,
    })));
    const lifecycleById = new Map<string, string>(indexes.map((index) => [index.id, index.lifecycle]));
    const execute = vi.fn(async (operation: Readonly<Record<string, unknown>>) => {
      if (operation.operation === 'recovery.list') return { candidates: [{ run, parentAttempt: 5 }] };
      if (operation.operation === 'run-key.census') return createPlainWorkflowRunKeyCensusFixture({ runId, accountId });
      if (operation.operation === 'invocations.list') return { invocations: indexes };
      if (operation.operation === 'invocations.get') {
        const ordinal = indexes.findIndex((index) => index.id === operation.invocationId);
        const index = indexes[ordinal]!;
        return { invocation: { index: { ...index, lifecycle: lifecycleById.get(index.id) }, contentEnvelope: envelopes[ordinal] } };
      }
      if (operation.operation === 'invocations.fact') {
        lifecycleById.set(String(operation.invocationId), String(operation.lifecycle));
        return { lifecycle: operation.lifecycle };
      }
      if (operation.operation === 'get') return { run, acceptedEnvelope: directAcceptedEnvelope(), checkpointEnvelope: checkpointEnvelope() };
      if (operation.operation === 'transition') return { ...run, state: 'cancelled', workflowCustodyState: 'settled' };
      throw new Error(`unexpected:${String(operation.operation)}`);
    });
    const reconcileInvocation = vi.fn(async () => ({ kind: 'completed' as const, result: 'completed-before-stop' }));
    const recover = createWorkflowRunRecoveryReader({
      accountId, machineId, storage: { execute },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation,
    });

    await recover('control');

    expect(reconcileInvocation).toHaveBeenCalledTimes(1);
    expect(reconcileInvocation).toHaveBeenCalledWith(expect.objectContaining({
      trigger: 'control',
      cancellationRequested: true,
    }));
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.fact'
      && operation.invocationId === rootId && operation.expectedLifecycle === 'cancel_requested' && operation.lifecycle === 'cancelled')).toBe(true);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'invocations.fact'
      && operation.invocationId === childId && operation.expectedLifecycle === 'cancel_requested' && operation.lifecycle === 'completed')).toBe(true);
    expect(execute.mock.calls.some(([operation]) => operation.operation === 'transition'
      && operation.state === 'cancelled' && operation.custodyState === 'settled'
      && Array.isArray(operation.invocationTransitions) && operation.invocationTransitions.length === 2)).toBe(true);
  });
});
