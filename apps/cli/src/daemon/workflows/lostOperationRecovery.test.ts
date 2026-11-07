import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
  openWorkflowProgressStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1,
  type WorkflowDefinitionV1, type WorkflowProgressEnvelopeV1,
} from '@happier-dev/protocol';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createWorkflowInvocationRecoveryObserver, observeWorkflowInvocationRecoveryEvidence } from './invocationRecoveryObserver';
import { createWorkflowInvocationRecoveryFactWriter, createWorkflowRunRecoveryReader } from './recovery';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';

afterEach(() => vi.useRealTimers());

describe('lost Action operation recovery', () => {
  it('keeps a still-live sibling under native observation when another operation is absent', async () => {
    let settled = false;
    const live = () => ({ version: 1, operationId: 'live', revision: settled ? 2 : 1,
      actionId: 'projects.script.run', state: settled ? 'succeeded' : 'running',
      scope: { accountId: 'account', machineId: 'machine' }, title: 'Script', createdAt: 1, startedAt: 2, cancellation: 'supported',
      ...(settled ? { settledAt: 3, result: {} } : {}),
    });
    const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId: 'machine',
      actionExecutor: { execute: async () => { throw new Error('No replay'); } },
      nativeActionOperations: {
        get: async target => target.operationId === 'lost' ? { kind: 'not_found' } : { kind: 'found', operation: live() },
        cancel: async () => { throw new Error('No unsolicited Stop'); },
        wait: async () => { settled = true; return { kind: 'found', operation: live() }; },
      } });
    const progress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'action',
      invocationPath: { blockId: 'script', scope: [] }, attempt: '0', logicalInvocationRecordId: '33333333-3333-4333-8333-333333333333',
      execution: { kind: 'action', actionId: 'projects.script.run', actionRequestId: 'request', localInputId: 'request', input: {}, output: {},
        awaitedOperations: ['lost', 'live'].map(operationId => ({ key: operationId, serverId: 'home', machineId: 'machine', operationId })) } };
    const observed = await observe({ progress, terminalParent: false, cancellationRequested: false });
    expect(observed).toMatchObject({ kind: 'unresolved', code: 'action_operation_pending', waitForCompletion: expect.any(Function) });
    if (observed.kind !== 'unresolved' || !observed.waitForCompletion) throw new Error('Live sibling must retain native custody');
    await observed.waitForCompletion();
    expect(await observe({ progress, terminalParent: false, cancellationRequested: false }))
      .toEqual({ kind: 'outcome_uncertain', code: 'action_operation_not_found' });
  });
  it.each([['cancelled', 'running'], ['interrupted', 'running'], ['paused', 'running'], ['claimed', 'running'],
    ['interrupted', 'setup_consent'], ['interrupted', 'uncertain'], ['paused', 'uncertain']] as const)(
    'records a lost operation once for a %s Run (initial %s) and stops reading for a minute without terminalizing resumable work', async (parentState, initial) => {
    const accountId = 'account-1', machineId = 'machine-1';
    const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
    const rootId = '2aaf1a39-4c48-4904-83a4-7eae318dfc2c';
    const childId = '33333333-3333-4333-8333-333333333333';
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {},
      blocks: [{ kind: 'action', id: 'script', actionId: 'projects.script.run', input: {} }] };
    const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint: {
        kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '2', frontier: { nextBlockOrdinal: 1, paused: false },
      } }));
    const kit = createWorkflowRunStorageTestkit({ accountId, runId, machineId, now: '2026-10-27T00:00:00.000Z', origin: { kind: 'direct' },
      acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
          definition, authoredDefinition: definition, startedBy: 'user', workDepth: 0, metadata: null, frozenChildren: {},
          materializedLeaves: [], source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
          workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' }, originalCommittedRevision: 'a'.repeat(40) },
          origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
        } })) });
    const seal = (root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: root ? rootId : childId,
        sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'action',
        invocationPath: { blockId: root ? '$root' : 'script', scope: [] }, attempt: '0', logicalInvocationRecordId: root ? rootId : childId,
        ...(!root && initial === 'uncertain' ? { result: { retained: 'historical' },
          reason: { code: 'outcome_uncertain', message: 'Retained diagnostic context' } } : {}),
        ...(!root ? { execution: { kind: 'action' as const, actionId: 'projects.script.run', actionRequestId: 'request', localInputId: 'request',
          input: {}, output: {}, awaitedOperations: [{ key: 'command', serverId: 'home', machineId, operationId: 'lost' }] } } : {}),
      } }));
    await kit.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope,
      rootInvocation: { id: rootId, contentEnvelope: seal(true) } });
    await kit.execute({ operation: 'invocations.admit', runId, expectedRevision: kit.run().revision, checkpointEnvelope,
      invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'running', contentEnvelope: seal(false) }] });
    if (initial !== 'running') {
      const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run: kit.run(), parentAttempt: 0, storage: kit,
        encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
      const invocation = await writer.readInvocation(childId);
      if (!invocation) throw new Error('Missing retained invocation');
      if (initial === 'uncertain') {
        expect(await writer.commitObservation(invocation, { kind: 'outcome_uncertain', code: 'outcome_uncertain' }))
          .toMatchObject({ lifecycle: 'outcome_uncertain' });
      } else expect(await writer.commitObservation(invocation, { kind: 'unresolved', code: 'project_setup_consent_required', setupConsentOutput: {
        operation: { version: 1, operationId: 'lost', revision: 2, actionId: 'projects.script.run', state: 'running',
          scope: { accountId, machineId }, title: 'Script', createdAt: 1, startedAt: 2, cancellation: 'supported',
          domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: 'home', machineId, workspaceRefId: 'workspace', cwd: '/repo' },
          setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed', reviewedEffect: { commands: [] } },
        },
      } })).toMatchObject({ lifecycle: 'needs_attention' });
    }
    if (parentState === 'cancelled') kit.requestControl('cancelled');
    else await kit.execute({ operation: 'transition', runId, expectedRevision: kit.run().revision, checkpointEnvelope, state: parentState });
    // A restarted daemon's real operation owner has no retained process-local id.
    const runtime = createHostActionOperationRuntime({ machineId, resolveAccountId: async () => accountId });
    let gets = 0;
    const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId,
      actionExecutor: { execute: async () => { throw new Error('Lost operation must not replay'); } },
      nativeActionOperations: {
        get: async target => { gets++; return await runtime.handlers.getV2({ operationId: target.operationId }); },
        cancel: async () => { throw new Error('An absent owner cannot be stopped'); },
        wait: async () => { throw new Error('An absent owner cannot be awaited'); },
      } });
    let lossWrites = 0;
    const recover = createWorkflowRunRecoveryReader({ accountId, machineId, storage: { execute: async (operation, options) => {
      if (operation.operation === 'recovery.list') return {
        candidates: kit.run().workflowCustodyState === 'pending' ? [{ run: kit.run(), parentAttempt: 0 }] : [],
      };
      const before = kit.rowById(childId)?.index.contentRevision;
      const response = await kit.execute(operation, options);
      if (operation.operation === 'invocations.fact' && operation.invocationId === childId
        && kit.rowById(childId)?.index.contentRevision !== before) lossWrites++;
      return response;
    } },
      resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      reconcileInvocation: observe });
    await recover('startup');
    expect(gets).toBe(1);
    expect(lossWrites).toBe(1);
    expect(kit.run()).toMatchObject({ state: parentState, workflowCustodyState: parentState === 'cancelled' ? 'settled' : 'pending' });
    const child = kit.rowById(childId)!;
    expect(child.index.lifecycle).toBe('outcome_uncertain');
    const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId,
      recordId: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', attempt: '0' },
      envelope: parseWorkflowStoredContentEnvelopeV1(child.contentEnvelope) });
    expect(opened).toMatchObject({ kind: 'available',
        content: { reason: { code: 'action_operation_not_found' } } });
    if (initial === 'uncertain') expect(opened).toMatchObject({ kind: 'available', content: {
      result: { retained: 'historical' }, reason: { message: 'Retained diagnostic context' },
    } });
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(60_000);
    await recover('reconnect');
    await recover('control');
    // Recovery controls use a distinct evidence reader. The committed loss
    // fact must stop that network reader too, without asserting not-active.
    if (opened.kind !== 'available') throw new Error('Missing committed loss fact');
    expect(await observeWorkflowInvocationRecoveryEvidence({ runId, credentials: { token: 'token', encryption: null }, machineId,
      progress: opened.content,
      getOperation: async target => { gets++; return await runtime.handlers.getV2({ operationId: target.operationId }); },
      getRun: async () => { throw new Error('No invented Execution Run'); } })).toMatchObject({ activity: 'unknown' });
    expect(gets).toBe(1);
    expect(lossWrites).toBe(1);
  });
});
