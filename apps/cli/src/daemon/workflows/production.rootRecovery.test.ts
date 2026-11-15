import { describe, expect, it, vi } from 'vitest';
import axios, { AxiosError, AxiosHeaders } from 'axios';
import {
  createWorkflowAccountRunActionOwner,
  materializeWorkflowAcceptedSnapshotV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
  WorkflowDefinitionV1Schema,
  WorkflowAcceptedSnapshotV1Schema,
  WorkflowProgressEnvelopeV1Schema,
} from '@happier-dev/protocol';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { createProductionWorkflowRunCoordinator, DurableWorkflowCoordinatorStore } from './production';
import { workflowInvocationKey } from './coordinator';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import { executeClaimedRun } from '@/daemon/automation/automationRunExecutor';
import { createAutomationClaimClient } from '@/daemon/automation/automationClaimClient';
import { WORKFLOW_CANCEL_REQUESTED_ABORT_REASON } from './coordinator';

const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
const accountId = 'account-1';
const machineId = 'machine-1';
const rootId = 'recovered-root';
const encryption = { witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null },
  runCrypto: { mode: 'plain' as const } };

async function interruptedRoot(lifecycle: 'pending' | 'running' | 'needs_attention', claimOrigin: 'direct' | 'automation' = 'direct',
  condition: 'onlyWhen' | 'runWhen' = 'onlyWhen', authoredDefinition?: unknown,
  executionTarget: 'session' | 'detached_run' = 'detached_run') {
  const origin = claimOrigin === 'direct' ? { kind: 'direct' as const }
    : { kind: 'automation' as const, automationId: 'automation-1' };
  const definition = WorkflowDefinitionV1Schema.parse(authoredDefinition ?? { version: 1, inputs: [], blocks: [
    { kind: 'wait', id: 'check', document: { text: 'Review if needed', references: [], attachments: [] },
      ...(condition === 'runWhen' ? { runWhen: 'failure' } : {
        onlyWhen: { kind: 'compare', operator: 'eq', left: { kind: 'literal', value: true },
          right: { kind: 'literal', value: false } } }) },
  ] });
  const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
    context: { source: origin.kind === 'direct' ? { kind: 'inline' } : origin, inputs: {}, machineId, executionTarget: { kind: executionTarget },
      workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
      ...(origin.kind === 'direct' ? { origin } : {}), authorization: { principal: { kind: 'host' } } },
    admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
  if (!accepted.ok) throw new Error(accepted.error.code);
  const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
    mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot,
  }));
  const storage = createWorkflowRunStorageTestkit({ runId, machineId, origin, acceptedEnvelope });
  const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: rootId,
    nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } };
  await storage.execute({ operation: 'initialize', runId, expectedRevision: 0,
    checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint })),
    rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId,
        recordId: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root', attempt: '0',
        invocationPath: { blockId: '$root', scope: [] }, logicalInvocationRecordId: rootId },
    })) } });
  const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
    rootRecordId: rootId, checkpoint, encryption, storage, revision: storage.run().revision });
  const rootKey = workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 });
  await store.commitFact({ key: rootKey, lifecycle, reason: 'storage_unavailable', reasonMessage: 'Storage failed before recovery.' });
  const reader = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => accountId, storage,
    definitions: { get: async () => { throw new Error('unexpected_definition_read'); } },
    resolveEncryption: async () => ({ kind: 'available', witness: encryption.witness }),
    normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
    randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
  });
  const readRoot = async () => WorkflowActionOutputSchemasV1['workflow.run.invocations.get'].parse(await reader.execute({
    actionId: 'workflow.run.invocations.get', input: { runId, invocationId: rootId }, context: {},
  })).invocation;
  return { acceptedEnvelope, storage, store, rootKey, readRoot, reader, checkpoint };
}

function recoveredCoordinator(storage: ReturnType<typeof createWorkflowRunStorageTestkit>) {
  return createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId, storage,
    execution: { credentials: { token: 'token', encryption: null }, serverId: 'server-1',
      machineAdmissionTransport: async () => { throw new Error('unexpected_session_input'); },
      resolveExistingSessionConversation: async () => { throw new Error('unexpected_session'); },
      detachedRun: { actionExecutor: { execute: async () => { throw new Error('unexpected_detached_input'); } },
        buildActionContext: () => ({ surface: 'cli', authority: 'account_automation' }) } },
    onCommittedTransition: async () => {},
    resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
    resolveAccountEncryption: async () => ({ kind: 'available', witness: encryption.witness }),
    isAcceptedAuthorizationCurrent: async () => true,
  });
}

async function heldHeartbeatRun(options: { holdAfterOpen?: boolean; delayedClaimOrigin?: 'direct' | 'automation' } = {}) {
  const h = await interruptedRoot('pending', options.delayedClaimOrigin);
  let releaseRead = () => {};
  let readStarted = () => {};
  const reading = new Promise<void>(resolve => { readStarted = resolve; });
  const delayedRead = new Promise<void>(resolve => { releaseRead = resolve; });
  let held = false;
  let signal: AbortSignal | undefined;
  const worker = new AbortController();
  const coordinate = recoveredCoordinator({ ...h.storage, execute: async (operation, request) => {
    signal ??= request?.signal;
    if (!held && (options.holdAfterOpen
      ? operation.operation === 'invocations.fact' && operation.lifecycle === 'running'
      : operation.operation === 'get')) {
      held = true;
      readStarted();
      await delayedRead;
      signal?.throwIfAborted();
    }
    return await h.storage.execute(operation, request);
  } });
  const claimClient = createAutomationClaimClient({ token: 'test-token', createPublisherHeader: async () => null });
  const run = { id: runId, attempt: options.delayedClaimOrigin ? 1 : 0, revision: h.storage.run().revision,
    leaseExpiresAt: Date.now() + 30_000, workflowAcceptedSnapshotEnvelope: h.acceptedEnvelope, triggerId: null };
  let claimed: Parameters<typeof executeClaimedRun>[0]['claimed'] = {
    protocol: 'v3', automation: null, accountCurrentness: encryption.witness,
    run: { ...run, automationId: null, origin: { kind: 'direct' } },
  };
  if (options.delayedClaimOrigin) {
    const automation = options.delayedClaimOrigin === 'automation' ? { id: 'automation-1', name: 'Recovery', enabled: true } : null;
    // Only the HTTP delivery and clock are faked. The strict claim parser,
    // private projection, executor and Workflow coordinator remain real.
    vi.spyOn(axios, 'post').mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 10_000);
      return { data: { accountCurrentness: encryption.witness, automation,
        run: { ...run, recipeKind: 'workflow-v2', triggerRetired: false,
          ...(automation ? { automationId: automation.id, executionInputEnvelope: '{}', automationEvidenceEnvelope: null,
            cause: { kind: 'manual', invokedAt: 0 } } : { automationId: null, origin: { kind: 'direct' } }),
        } } };
    });
    const response = await claimClient.claimRun({ machineId, leaseDurationMs: 30_000, scope: 'workflow' });
    if (!response.run) throw new Error('Expected the delayed successful claim');
    claimed = response;
  }
  const execution = executeClaimedRun({ machineId, heartbeatMs: 5_000, leaseDurationMs: 30_000,
    coordinateWorkflowRun: coordinate, claimClient, signal: worker.signal,
    claimed,
  });
  await Promise.race([reading, execution]);
  return { ...h, execution, releaseRead, worker, signal: () => signal };
}

function heartbeatHttpFailure(status?: number) {
  return new AxiosError('heartbeat failed', status === undefined ? 'ECONNABORTED' : 'ERR_BAD_RESPONSE', undefined, undefined,
    status === undefined ? undefined : { status, statusText: 'Refused', headers: {}, config: { headers: new AxiosHeaders() },
      data: { error: 'automation_run_not_found_or_not_claimed' } });
}

describe('Workflow root recovery', () => {
  it.each([true, false])('recovers an interrupted parallel comparison without replaying completed candidates (all completed: %s)', async allCompleted => {
    const branches = ['first', 'second', 'third'].map(id => ({ id, blocks: [{ kind: 'step', id: `implement-${id}`,
      document: { text: 'Implement independently', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] }));
    const h = await interruptedRoot('running', 'direct', 'onlyWhen', { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
      blocks: [{ kind: 'parallel', id: 'implementations', failurePolicy: 'collect_outcomes', branches },
        { kind: 'wait', id: 'compare', document: { text: 'Compare the completed candidates', references: [], attachments: [] },
          onlyWhen: { kind: 'all', conditions: branches.map((branch, index) => ({ kind: 'compare', operator: 'eq',
            left: { kind: 'result', producer: { blockId: 'implementations', scope: { kind: 'current' } },
              path: [index, 'results', `implement-${branch.id}`] },
            right: { kind: 'literal', value: `candidate output ${branch.id}` } })) } }] }, 'session');
    const parentKey = workflowInvocationKey({ runId, blockId: 'implementations', scope: [], attempt: 0 });
    await h.store.ensureIntent({ key: parentKey, recordId: 'implementations', runId, blockId: 'implementations',
      blockKind: 'parallel', parentKey: h.rootKey, memberOrdinal: '0', path: { blockId: 'implementations', scope: [] },
      attempt: 0, acceptedAtMs: 1, lifecycle: 'needs_attention', reason: 'result_read_failed',
      container: { kind: 'parallel', nextBranchOrdinal: '3' } });
    await h.store.commitFact({ key: parentKey, lifecycle: 'needs_attention', reason: 'result_read_failed' });
    const candidateIds: string[] = [];
    for (const [index, branch] of branches.entries()) {
      const scope = [{ kind: 'branch' as const, blockId: 'implementations', branchId: branch.id }];
      const frameKey = workflowInvocationKey({ runId, blockId: 'implementations', scope, attempt: 0 });
      await h.store.ensureIntent({ key: frameKey, recordId: `frame-${branch.id}`, runId, blockId: 'implementations',
        blockKind: 'parallel', parentKey, memberOrdinal: String(index), path: { blockId: 'implementations', scope },
        attempt: 0, acceptedAtMs: 2 + index, lifecycle: index === 1 ? 'completed' : 'needs_attention',
        ...(index === 1 ? { containerResult: { kind: 'container' as const, containerRecordId: `frame-${branch.id}` } }
          : { reason: 'result_read_failed' }),
        frame: { ownerBlockId: 'implementations', source: { kind: 'branch', branchId: branch.id } },
        container: { kind: 'body', nextBlockOrdinal: index === 1 ? '1' : '0' } });
      if (index !== 1) await h.store.commitFact({ key: frameKey, lifecycle: 'needs_attention', reason: 'result_read_failed' });
      const blockId = `implement-${branch.id}`;
      const recordId = `candidate-${branch.id}`;
      candidateIds.push(recordId);
      const key = workflowInvocationKey({ runId, blockId, scope, attempt: 0 });
      await h.store.ensureIntent({ key, recordId,
        runId, blockId, blockKind: 'step', parentKey: frameKey, memberOrdinal: '0', path: { blockId, scope },
        attempt: 0, acceptedAtMs: 5 + index, lifecycle: 'pending',
        execution: { kind: 'session', sessionId: `session-${branch.id}`, localInputId: `input-${branch.id}` } });
      await h.store.commitFact({ key, lifecycle: allCompleted || index < 2 ? 'completed' : 'waiting_for_review',
        ...(allCompleted || index < 2 ? { result: `candidate output ${branch.id}` } : {}) });
    }
    await h.storage.execute({ operation: 'transition', runId, parentAttempt: 0, accountCurrentness: encryption.witness,
      expectedRevision: h.storage.run().revision, state: 'interrupted', checkpointEnvelope: h.storage.checkpointEnvelope()! });
    const candidateBytes = candidateIds.map(id => structuredClone(h.storage.rowById(id)));
    const detail = WorkflowActionOutputSchemasV1['workflow.run.invocations.get'].parse(await h.reader.execute({
      actionId: 'workflow.run.invocations.get', input: { runId, invocationId: 'implementations' }, context: {} }));
    expect(detail.invocation.recoveryAvailability?.retry).toEqual({ kind: 'available', causalInvocationIds: ['implementations'] });
    const recovered = WorkflowActionOutputSchemasV1['workflow.run.invocations.retry'].parse(await h.reader.execute({
      actionId: 'workflow.run.invocations.retry', input: { runId, expectedRevision: h.storage.run().revision,
        invocation: { recordId: 'implementations' }, causalInvocationIds: ['implementations'], conversation: 'fresh_agent',
        input: { kind: 'original' } }, context: { authority: 'present_user', callerPermissionMode: 'yolo' } }));
    expect(recovered.disposition).toBe('accepted');
    const outcome = await recoveredCoordinator(h.storage)({ runId, attempt: 1, expectedRevision: h.storage.run().revision,
      acceptedEnvelope: h.acceptedEnvelope, accountCurrentness: encryption.witness });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ state: 'waiting_for_review' });
    expect(h.storage.rows().find(row => row.index.parentRecordId === rootId && row.index.memberOrdinal === '1')?.index.lifecycle)
      .toBe(allCompleted ? 'waiting_for_review' : undefined);
    expect(candidateIds.map(id => h.storage.rowById(id))).toEqual(candidateBytes);
    expect(h.storage.rows().filter(row => candidateIds.includes(row.index.id))).toHaveLength(3);
  });

  it.each(['onlyWhen', 'runWhen'] as const)('preserves a false %s after storage loses the skip fact', async condition => {
    const h = await interruptedRoot('pending', 'direct', condition);
    const failure = new Error('skip_fact_not_written');
    let skipFault = true;
    // Fault only the persistent storage boundary; replay the real durable
    // coordinator and reject an incorrectly opened human review immediately.
    const storage = { ...h.storage, execute: async (operation: Parameters<typeof h.storage.execute>[0]) => {
      if (operation.operation === 'invocations.fact' && operation.lifecycle === 'skipped' && skipFault) {
        skipFault = false;
        throw failure;
      }
      if (operation.operation === 'invocations.fact' && operation.lifecycle === 'waiting_for_review') {
        throw new Error('false_condition_entered_review');
      }
      return h.storage.execute(operation);
    } };
    await expect(recoveredCoordinator(storage)({ runId, attempt: 0, expectedRevision: h.storage.run().revision,
      acceptedEnvelope: h.acceptedEnvelope, accountCurrentness: encryption.witness })).rejects.toBe(failure);
    expect(skipFault).toBe(false);
    await expect(recoveredCoordinator(storage)({ runId, attempt: 1, expectedRevision: h.storage.run().revision,
      acceptedEnvelope: h.acceptedEnvelope, accountCurrentness: encryption.witness })).resolves.toMatchObject({ state: 'succeeded' });
    const children = h.storage.rows().filter(row => row.index.parentRecordId !== null);
    expect(children).toHaveLength(1);
    expect(children[0]?.index.lifecycle).toBe('skipped');
  });

  it('commits the frontier through one content-free control read', async () => {
    const h = await interruptedRoot('pending');
    const reads: { request: Parameters<typeof h.storage.execute>[0]; response: unknown }[] = [];
    const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
      rootRecordId: rootId, checkpoint: h.checkpoint, encryption, revision: h.storage.run().revision,
      storage: { execute: async (request, options) => {
        const response = await h.storage.execute(request, options);
        if (request.operation === 'get') reads.push({ request, response });
        return response;
      } } });
    await store.commitFrontier({ nextBlockOrdinal: 1 });
    expect(store.checkpoint.frontier.nextBlockOrdinal).toBe(1);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.request).toMatchObject({ operation: 'get', projection: 'control' });
    expect(reads[0]?.response).toMatchObject({ run: { state: h.storage.run().state, revision: expect.any(Number) } });
    for (const field of ['acceptedEnvelope', 'checkpointEnvelope', 'resultEnvelope', 'keyCensus']) {
      expect(reads[0]?.response).not.toHaveProperty(field);
    }
  });

  it('confirms review rows through one revision-only read without reopening Run content', async () => {
    const h = await interruptedRoot('pending');
    const reads: { request: Parameters<typeof h.storage.execute>[0]; response: unknown }[] = [];
    const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
      rootRecordId: rootId, checkpoint: h.checkpoint, encryption, revision: h.storage.run().revision,
      storage: { execute: async (request, options) => {
        const response = await h.storage.execute(request, options);
        if (request.operation === 'get') reads.push({ request, response });
        return response;
      } } });
    const revision = h.storage.run().revision;
    await expect(store.confirmReviewHolds({ runId, recordIds: [rootId] })).resolves.toMatchObject({
      revision, control: 'running', rows: [{ recordId: rootId, lifecycle: 'pending' }],
    });
    expect(reads).toEqual([{ request: { operation: 'get', runId, projection: 'revision' },
      response: { run: { state: h.storage.run().state, revision } } }]);
  });

  it.each(['get', 'invocations.get'] as const)('cancels pending %s storage when the containing worker stops', async operation => {
    const h = await interruptedRoot('pending');
    const controller = new AbortController();
    let entered!: () => void;
    const sending = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    let receivedSignal: AbortSignal | undefined;
    const cancellation = Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' });
    const coordinate = recoveredCoordinator({ ...h.storage, execute: async (request, options) => {
      if (request.operation === operation) return await new Promise((_resolve, reject) => {
        receivedSignal = options?.signal;
        release = () => reject(cancellation);
        receivedSignal?.addEventListener('abort', release, { once: true });
        entered();
      });
      return await h.storage.execute(request, options);
    } });
    const running = expect(coordinate({ runId, attempt: 0, expectedRevision: h.storage.run().revision,
      acceptedEnvelope: h.acceptedEnvelope, accountCurrentness: encryption.witness, storageSignal: controller.signal }))
      .rejects.toMatchObject({ code: 'ERR_CANCELED' });
    await sending;
    try {
      expect.soft(receivedSignal).toBe(controller.signal);
      controller.abort();
    } finally { release(); }
    await running;
  });

  it('keeps terminal storage alive after Stop cancels leaf execution', async () => {
    const h = await interruptedRoot('pending');
    const worker = new AbortController();
    const execution = new AbortController();
    let stopped = false;
    const postStopSignals: Array<AbortSignal | undefined> = [];
    const coordinate = recoveredCoordinator({ ...h.storage, execute: async (operation, options) => {
      if (!stopped && operation.operation === 'get' && operation.projection === 'control') {
        stopped = true;
        h.storage.requestControl('cancel_requested');
        execution.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
      }
      if (stopped) {
        postStopSignals.push(options?.signal);
        options?.signal?.throwIfAborted();
      }
      return await h.storage.execute(operation, options);
    } });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: h.storage.run().revision,
      acceptedEnvelope: h.acceptedEnvelope, accountCurrentness: encryption.witness,
      signal: execution.signal, storageSignal: worker.signal })).resolves.toMatchObject({ state: 'cancelled' });
    expect(h.storage.run().state).toBe('cancelled');
    expect(postStopSignals.length).toBeGreaterThan(0);
    expect(postStopSignals.every(signal => signal === worker.signal && !signal.aborted)).toBe(true);
  });

  it('trusts semantically admitted content when loading durable rows and the accepted program', async () => {
    const h = await interruptedRoot('pending');
    // Observe the real schemas; the stored-content openers still perform their
    // purpose-bound validation beneath this production consumer.
    const progressParses = vi.spyOn(WorkflowProgressEnvelopeV1Schema, 'parse');
    try {
      const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
        rootRecordId: rootId, checkpoint: h.checkpoint, encryption, storage: h.storage,
        revision: h.storage.run().revision });
      expect(await store.readByLogicalInvocation(rootId)).toMatchObject({ blockKind: 'root', lifecycle: 'pending' });
      expect(progressParses).not.toHaveBeenCalled();
    } finally { progressParses.mockRestore(); }
    const acceptedParses = vi.spyOn(WorkflowAcceptedSnapshotV1Schema, 'parse');
    try {
      await expect(recoveredCoordinator(h.storage)({ runId, attempt: 0, expectedRevision: h.storage.run().revision,
        acceptedEnvelope: h.acceptedEnvelope, accountCurrentness: encryption.witness }))
        .resolves.toMatchObject({ state: 'succeeded' });
      expect(acceptedParses).not.toHaveBeenCalled();
    } finally { acceptedParses.mockRestore(); }
  });

  it('publishes running before continuing a reclaimed running root', async () => {
    const h = await interruptedRoot('running');
    await h.storage.execute({ operation: 'transition', runId,
      expectedRevision: h.storage.run().revision, state: 'claimed',
      checkpointEnvelope: h.storage.checkpointEnvelope() });
    let stateAtNextStep: ReturnType<typeof h.storage.run>['state'] | undefined;
    const coordinate = recoveredCoordinator({ ...h.storage, execute: async (operation, request) => {
      if (operation.operation === 'invocations.admit') stateAtNextStep = h.storage.run().state;
      return h.storage.execute(operation, request);
    } });

    await expect(coordinate({ runId, attempt: 1, expectedRevision: h.storage.run().revision,
      acceptedEnvelope: h.acceptedEnvelope, accountCurrentness: encryption.witness }))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(stateAtNextStep).toBe('running');
    expect(h.storage.rows().filter(row => row.index.parentRecordId === null).map(row => row.index.id))
      .toEqual([rootId]);
  });

  it.each([false, true])('rejoins producer-replaced roots and inherits current members through repeated recovery (legacy checkpoint=%s)', async legacyCheckpoint => {
    const h = await interruptedRoot('pending');
    const child = await h.store.ensureIntent({ key: workflowInvocationKey({ runId, blockId: 'check', scope: [], attempt: 0 }),
      recordId: 'inherited-check', runId, blockId: 'check', path: { blockId: 'check', scope: [] },
      attempt: 0, acceptedAtMs: Date.now(), lifecycle: 'pending', blockKind: 'wait', parentKey: h.rootKey, memberOrdinal: '0' });
    await h.store.commitFact({ key: child.key, lifecycle: 'skipped' });
    let store = h.store;
    let currentRootId = rootId;
    const context = { surface: 'ui' as const, authority: 'present_user' as const, callerPermissionMode: 'yolo' as const };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const root = await store.readByLogicalInvocation(currentRootId);
      if (!root) throw new Error('missing_root');
      await store.commitFact({ key: root.key, lifecycle: 'needs_attention', reason: 'storage_unavailable' });
      await h.storage.execute({ operation: 'transition', runId, expectedRevision: h.storage.run().revision,
        state: 'interrupted', checkpointEnvelope: h.storage.checkpointEnvelope() });
      const detail = WorkflowActionOutputSchemasV1['workflow.run.invocations.get'].parse(await h.reader.execute({
        actionId: 'workflow.run.invocations.get', input: { runId, invocationId: currentRootId }, context }));
      const retry = detail.invocation.recoveryAvailability?.retry;
      if (retry?.kind !== 'available') throw new Error('root_retry_unavailable');
      const result = WorkflowActionOutputSchemasV1['workflow.run.invocations.retry'].parse(await h.reader.execute({
        actionId: 'workflow.run.invocations.retry', input: { runId, invocation: { recordId: currentRootId },
          expectedRevision: h.storage.run().revision, causalInvocationIds: retry.causalInvocationIds,
          conversation: 'fresh_agent', input: { kind: 'original' } }, context }));
      currentRootId = result.invocation.id;
      if (legacyCheckpoint) {
        const current = WorkflowActionOutputSchemasV1['workflow.run.get'].parse(await h.reader.execute({
          actionId: 'workflow.run.get', input: { runId, includeUsage: false }, context }));
        if (!current.checkpoint) throw new Error('missing_checkpoint');
        await h.storage.execute({ operation: 'transition', runId, expectedRevision: h.storage.run().revision, state: 'queued',
          checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint: { ...current.checkpoint, rootRecordId: rootId } })) });
      }
      const opened = WorkflowActionOutputSchemasV1['workflow.run.get'].parse(await h.reader.execute({
        actionId: 'workflow.run.get', input: { runId, includeUsage: false }, context }));
      expect(opened.checkpoint?.rootRecordId).toBe(legacyCheckpoint ? rootId : currentRootId);
      if (!opened.checkpoint) throw new Error('missing_checkpoint');
      store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
        rootRecordId: opened.checkpoint.rootRecordId, checkpoint: opened.checkpoint, encryption,
        storage: h.storage, revision: opened.run.revision });
      expect(store.rootIndex?.id).toBe(currentRootId);
      const currentRoot = await store.readByLogicalInvocation(currentRootId);
      expect(currentRoot).toMatchObject({ attempt, previousAttemptRecordId: root.recordId });
      await expect(store.readControl()).resolves.toBe('running');
      await expect(store.readCurrent({ runId, blockId: 'check', scope: [], parentKey: currentRoot!.key, memberOrdinal: '0' }))
        .resolves.toMatchObject({ recordId: child.recordId, lifecycle: 'skipped' });
      await expect(store.listCurrentMembers(currentRoot!.key)).resolves.toMatchObject([{ id: child.recordId, lifecycle: 'skipped' }]);
    }
    await expect(recoveredCoordinator(h.storage)({ runId, attempt: 0, expectedRevision: h.storage.run().revision,
      acceptedEnvelope: h.acceptedEnvelope, accountCurrentness: encryption.witness })).resolves.toMatchObject({ state: 'succeeded' });
    expect(h.storage.rowById(currentRootId)?.index.lifecycle).toBe('completed');
    expect(h.storage.rows().filter(row => row.index.parentRecordId !== null).map(row => row.index.id)).toEqual([child.recordId]);
  });

  it.each(['direct', 'automation'] as const)('preserves the server expiry after a delayed %s claim and failed, pending or successful renewal', async origin => {
    for (const mode of ['failed', 'pending', 'renewed'] as const) {
      vi.useFakeTimers(); vi.setSystemTime(0);
      let finishHeartbeat = () => {};
      const pendingHeartbeat = new Promise<{ data: { ok: true; leaseExpiresAt: number } }>(resolve => {
        finishHeartbeat = () => resolve({ data: { ok: true, leaseExpiresAt: 60_000 } });
      });
      const post = vi.spyOn(axios, 'post').mockRejectedValue(heartbeatHttpFailure());
      let h: Awaited<ReturnType<typeof heldHeartbeatRun>> | undefined;
      try {
        h = await heldHeartbeatRun({ delayedClaimOrigin: origin });
        expect(Date.now()).toBe(10_000);
        if (mode === 'pending') post.mockReturnValue(pendingHeartbeat);
        if (mode === 'renewed') post.mockResolvedValueOnce({ data: { ok: true, leaseExpiresAt: 45_000 } });
        await vi.advanceTimersByTimeAsync(19_999);
        expect(h.signal()?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.signal()?.aborted).toBe(mode !== 'renewed');
        if (mode === 'renewed') {
          await vi.advanceTimersByTimeAsync(14_999);
          expect(h.signal()?.aborted).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(h.signal()?.aborted).toBe(true);
        }
        finishHeartbeat(); await vi.advanceTimersByTimeAsync(0);
        expect(h.signal()?.aborted).toBe(true);
        expect(h.storage.run().state).not.toBe('succeeded');
      } finally {
        finishHeartbeat(); h?.worker.abort(); h?.releaseRead(); await h?.execution;
        post.mockRestore(); vi.useRealTimers();
      }
    }
  });

  it('lease heartbeat tolerates a transient failure on the first renewal after a successful claim', async () => {
    vi.useFakeTimers();
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => ({ data: { ok: true, leaseExpiresAt: Date.now() + 30_000 } }))
      .mockRejectedValueOnce(heartbeatHttpFailure());
    let h: Awaited<ReturnType<typeof heldHeartbeatRun>> | undefined;
    try {
      h = await heldHeartbeatRun();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.signal()?.aborted).toBe(false);
      h.releaseRead(); await h.execution;
      expect(h.storage.run().state).toBe('succeeded');
    } finally {
      h?.worker.abort(); h?.releaseRead(); await h?.execution;
      post.mockRestore(); vi.useRealTimers();
    }
  });

  it('lease heartbeat recovers after a slow request times out within the confirmed lease', async () => {
    vi.useFakeTimers();
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => ({ data: { ok: true, leaseExpiresAt: Date.now() + 30_000 } }));
    const h = await heldHeartbeatRun();
    try {
      // The claim client's existing HTTP deadline is 15s, independent of the
      // 30s lease. The request stays pending across several heartbeat ticks.
      post.mockImplementationOnce(() => new Promise((_, reject) => {
        setTimeout(() => reject(heartbeatHttpFailure()), 15_000);
      }));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(h.signal()?.aborted).toBe(false);
      h.releaseRead(); await h.execution;
      expect(h.storage.run().state).toBe('succeeded');
    } finally {
      h.worker.abort(); h.releaseRead(); await h.execution;
      post.mockRestore(); vi.useRealTimers();
    }
  });

  it.each([undefined, 503])('lease heartbeat tolerates transient HTTP failure (%s) and renews the same execution', async status => {
    vi.useFakeTimers();
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => ({ data: { ok: true, leaseExpiresAt: Date.now() + 30_000 } }));
    const h = await heldHeartbeatRun();
    try {
      post.mockRejectedValueOnce(heartbeatHttpFailure(status));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      post.mockRejectedValue(heartbeatHttpFailure());
      // Last success was at 10s: transient failures may not cut its lease short.
      await vi.advanceTimersByTimeAsync(29_999);
      expect(h.signal()?.aborted).toBe(false);
      h.releaseRead();
      await h.execution;
      expect(h.storage.run().state).toBe('succeeded');
      expect((await h.readRoot()).index.lifecycle).toBe('completed');
    } finally {
      h.worker.abort(); h.releaseRead(); await h.execution;
      post.mockRestore(); vi.useRealTimers();
    }
  });

  it.each(['failed', 'pending', 'renewed'] as const)('lease heartbeat aborts at the existing lease duration with a %s transport', async mode => {
    vi.useFakeTimers();
    let finishHeartbeat = () => {};
    const pendingHeartbeat = new Promise<{ data: { ok: true; leaseExpiresAt: number } }>(resolve => {
      finishHeartbeat = () => resolve({ data: { ok: true, leaseExpiresAt: Date.now() + 30_000 } });
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => ({ data: { ok: true, leaseExpiresAt: Date.now() + 30_000 } }));
    const h = await heldHeartbeatRun();
    try {
      post.mockRejectedValue(heartbeatHttpFailure());
      if (mode === 'pending') post.mockReturnValue(pendingHeartbeat);
      if (mode === 'renewed') post.mockResolvedValueOnce({ data: { ok: true, leaseExpiresAt: Date.now() + 35_000 } });
      const expiresAt = mode === 'renewed' ? 35_000 : 30_000;
      await vi.advanceTimersByTimeAsync(expiresAt - 1);
      expect(h.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.signal()?.aborted).toBe(true);
      finishHeartbeat();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.signal()?.aborted).toBe(true);
      h.releaseRead(); await h.execution;
      expect(h.storage.run().state).not.toBe('succeeded');
    } finally {
      finishHeartbeat(); h.worker.abort(); h.releaseRead(); await h.execution;
      post.mockRestore(); vi.useRealTimers();
    }
  });

  it.each([401, 403, 404])('lease heartbeat aborts immediately on definitive HTTP refusal (%s)', async status => {
    vi.useFakeTimers();
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => ({ data: { ok: true, leaseExpiresAt: Date.now() + 30_000 } }));
    const h = await heldHeartbeatRun();
    try {
      post.mockRejectedValue(heartbeatHttpFailure(status));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.signal()?.aborted).toBe(true);
    } finally {
      h.worker.abort(); h.releaseRead(); await h.execution;
      post.mockRestore(); vi.useRealTimers();
    }
  });

  it.each(['worker', 'cancel'] as const)('lease heartbeat preserves local %s aborts', async cause => {
    vi.useFakeTimers();
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => ({ data: { ok: true, leaseExpiresAt: Date.now() + 30_000 } }));
    const h = await heldHeartbeatRun({ holdAfterOpen: cause !== 'worker' });
    try {
      if (cause === 'worker') h.worker.abort('worker-retired');
      if (cause === 'cancel') h.worker.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.signal()?.aborted).toBe(true);
      expect(h.signal()?.reason).toBe(cause === 'worker' ? 'worker-retired' : WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
    } finally {
      h.worker.abort(); h.releaseRead(); await h.execution;
      post.mockRestore(); vi.useRealTimers();
    }
  });

  it('retains observation through heartbeat transport failures until the confirmed lease expires, then recovers the same Run', async () => {
    const h = await interruptedRoot('pending');
    let releaseRead = () => {};
    let readStarted = () => {};
    const reading = new Promise<void>(resolve => { readStarted = resolve; });
    const delayedRead = new Promise<void>(resolve => { releaseRead = resolve; });
    let firstRead = true;
    let interruptedReadSignal: AbortSignal | undefined;
    const storageUnavailable = Object.assign(new Error('storage_unavailable'), {
      response: { status: 503, data: { error: 'storage_unavailable' } },
    });
    const coordinate = recoveredCoordinator({ ...h.storage, execute: async (operation, options) => {
      if (firstRead && operation.operation === 'get') {
        firstRead = false;
        interruptedReadSignal = options?.signal;
        readStarted();
        await delayedRead;
        throw storageUnavailable;
      }
      return await h.storage.execute(operation, options);
    } });
    const execute = (attempt: number, heartbeatRun: () => Promise<number>) => executeClaimedRun({
      machineId, heartbeatMs: 1_000, leaseDurationMs: 30_000,
      coordinateWorkflowRun: coordinate,
      claimClient: { heartbeatRun, failRun: async () => { throw new Error('unexpected_direct_failure'); } },
      claimed: { protocol: 'v3', automation: null, accountCurrentness: encryption.witness,
        run: { id: runId, automationId: null, attempt, leaseExpiresAt: Date.now() + 30_000, revision: h.storage.run().revision,
          origin: { kind: 'direct' }, triggerId: null, workflowAcceptedSnapshotEnvelope: h.acceptedEnvelope } },
    });
    vi.useFakeTimers();
    try {
      const firstAttempt = execute(0, async () => {
        throw Object.assign(new Error('heartbeat_timeout'), { code: 'ECONNABORTED' });
      });
      await reading;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(interruptedReadSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(28_999);
      expect(interruptedReadSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(interruptedReadSignal?.aborted).toBe(true);
      releaseRead();
      await firstAttempt;
      // Unavailable storage cannot settle an effect outcome. Preserve the same
      // pending snapshot for the server's existing expired-lease claim owner.
      expect(h.storage.rows()).toHaveLength(1);
      expect(h.storage.run()).toMatchObject({ state: 'running', workflowCustodyState: 'pending' });

      // The server claim service separately proves the expired-lease rejoin and
      // stale-attempt fence. Consume its next claim through the real executor.
      await execute(1, async () => Date.now() + 30_000);
      expect(h.storage.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled' });
      expect((await h.readRoot()).index.lifecycle).toBe('completed');
    } finally {
      releaseRead();
      vi.useRealTimers();
    }
  });

  it.each(['pending', 'needs_attention', 'running'] as const)('clears the persisted root failure when a detached Run recovers from %s and succeeds', async lifecycle => {
    const h = await interruptedRoot(lifecycle);
    expect((await h.readRoot()).progress.reason?.code).toBe('storage_unavailable');
    const coordinate = recoveredCoordinator(h.storage);
    await expect(coordinate({ runId, attempt: 0, expectedRevision: h.storage.run().revision,
      acceptedEnvelope: h.acceptedEnvelope, accountCurrentness: encryption.witness })).resolves.toMatchObject({ state: 'succeeded' });
    expect(h.storage.run().state).toBe('succeeded');
    const root = await h.readRoot();
    expect(root.index.lifecycle).toBe('completed');
    expect(root.progress.reason).toBeUndefined();
  });

  it.each([false, true])('requires durable failure clearing after a lost root acknowledgment (committed=%s)', async committed => {
    const h = await interruptedRoot('running');
    const failure = new Error('root_recovery_acknowledgment_lost');
    let faultPending = true;
    const coordinate = recoveredCoordinator({ ...h.storage, execute: async operation => {
      if (faultPending && operation.operation === 'invocations.fact' && operation.invocationId === rootId
        && operation.lifecycle === 'running') {
        faultPending = false;
        if (committed) await h.storage.execute(operation);
        throw failure;
      }
      return await h.storage.execute(operation);
    } });
    const outcome = coordinate({ runId, attempt: 0, expectedRevision: h.storage.run().revision,
      acceptedEnvelope: h.acceptedEnvelope, accountCurrentness: encryption.witness });
    if (committed) {
      await expect(outcome).resolves.toMatchObject({ state: 'succeeded' });
      expect((await h.readRoot()).progress.reason).toBeUndefined();
    } else {
      await expect(outcome).rejects.toBe(failure);
      expect(h.storage.run().state).toBe('running');
      expect((await h.readRoot()).progress.reason?.code).toBe('storage_unavailable');
    }
    expect(faultPending).toBe(false);
  });

  it('records the current root failure after an earlier recoverable failure', async () => {
    const h = await interruptedRoot('needs_attention');
    await h.store.commitFact({ key: h.rootKey, lifecycle: 'needs_attention',
      reason: 'run_access_denied', reasonMessage: 'The resumed controller no longer has access.' });
    expect((await h.readRoot()).progress.reason).toEqual({ code: 'run_access_denied',
      message: 'The resumed controller no longer has access.' });
  });
});
