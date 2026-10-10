import { createTestWorkflowCoordinator as createWorkflowCoordinator } from './workflowCoordinator.testkit';
import { describe, expect, it } from 'vitest';
import { projectWorkflowRetainedRuntimeSelectionV1, type WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows';
import {  workflowInvocationKey, WORKFLOW_CANCEL_REQUESTED_ABORT_REASON } from './coordinator';
import { createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import { createWorkflowDetachedExecutionRunStepExecutor } from './executionRunStepExecutor';
import { createProductionWorkflowConversationOwner, createWorkflowSessionStepExecutor } from './sessionStepExecutor';


const authorization = { admittedPermissionCeiling: 'default', principal: { kind: 'host' } } as const;
const executionTarget = { kind: 'session' } as const;
const workspace = { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' } as const;
const leaf = (id: string, pauseForReview = false) => ({ kind: 'step' as const, id, pauseForReview,
  document: { text: id, references: [], attachments: [] }, input: [], result: { kind: 'text' as const } });
const definition = (blocks: WorkflowDefinitionV1['blocks']): WorkflowDefinitionV1 => ({ version: 1, inputs: [],
  defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } }, blocks });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('workflow review pipeline', () => {
  it('keeps Session context materialization in flight until an independent leaf can execute', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const contextRead = deferred<void>();
    const releaseContext = deferred<void>();
    const executed: string[] = [];
    const coordinator = createWorkflowCoordinator({ store, resolveWorkspace: async () => ({ ok: true, workspace }),
      isAcceptedAuthorizationCurrent: async () => true,
      sessionContext: { resolveSessionContext: async () => {
        contextRead.resolve(); await releaseContext.promise;
        return { usage: { kind: 'accounted' as const, tokensUsed: 42 }, turns: [], truncated: false };
      } },
      executeStep: async (params) => {
        executed.push(params.step.id);
        await params.beforeInputAdmission();
        await params.onInputAccepted({ kind: 'session', sessionId: params.step.id, localInputId: params.step.id });
        return { kind: 'completed', result: params.step.id };
      } });
    const activity: string[] = [];
    const unsubscribe = coordinator.liveWorkProducer.subscribe(() => {
      const observation = coordinator.liveWorkProducer.read();
      if (observation instanceof Promise) throw new Error('coordinator_activity_must_be_owner_local');
      activity.push(observation.items.some(item => item.state === 'active') ? 'busy' : 'idle');
    });
    expect(await coordinator.liveWorkProducer.read()).toEqual({ coverage: 'complete', items: [] });
    const running = coordinator.run({ runId: 'materialization', originSessionId: 'origin-session', definition: definition([{ kind: 'parallel', id: 'p', failurePolicy: 'fail_stop',
      branches: [{ id: 'a', blocks: [leaf('held', true)] }, { id: 'b', blocks: [{ ...leaf('context'),
        input: [{ kind: 'session_context', recentTurns: 0 }] }] }] }]), inputs: {}, executionTarget, authorization });
    await contextRead.promise;
    expect(await coordinator.liveWorkProducer.read()).toMatchObject({ coverage: 'complete', items: [
      { category: 'workflow_run', state: 'active', attribution: { kind: 'unknown' } },
    ] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseContext.resolve();
    expect((await running).state).toBe('waiting_for_review');
    expect(executed).toContain('context');
    expect(await coordinator.liveWorkProducer.read()).toEqual({ coverage: 'complete', items: [] });
    expect(activity).toContain('busy');
    expect(activity.at(-1)).toBe('idle');
    unsubscribe();
  });
  it.each([undefined, null] as const)('preserves fieldless Continue versus an actual JSON null value (%s)', async (value) => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const key = workflowInvocationKey({ runId: 'continue', blockId: 'person', scope: [], attempt: 0 });
    await store.ensureIntent({ key, recordId: 'person-row', runId: 'continue', blockKind: 'wait', blockId: 'person', memberOrdinal: '0',
      path: { blockId: 'person', scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
    await store.commitFact({ key, lifecycle: 'completed', ...(value === undefined ? {} : { result: value }) });
    const coordinator = createWorkflowCoordinator({ store, resolveWorkspace: async () => ({ ok: true, workspace }),
      isAcceptedAuthorizationCurrent: async () => true, executeStep: async (params) => {
        expect(params.input.values).toEqual(value === undefined ? [] : [null]);
        await params.beforeInputAdmission();
        await params.onInputAccepted({ kind: 'session', sessionId: 'session', localInputId: 'input' });
        return { kind: 'completed', result: 'done' };
      } });
    expect((await coordinator.run({ runId: 'continue', definition: definition([{ kind: 'wait', id: 'person',
      document: { text: 'Continue', references: [], attachments: [] }, ...(value === undefined ? {} : { result: { kind: 'json', schema: {} } }) },
      { ...leaf('tail'), input: [{ kind: 'result', producer: { scope: { kind: 'current' }, blockId: 'person' }, path: [], optional: true }] }]),
      inputs: {}, executionTarget, authorization })).state).toBe('succeeded');
  });
  it('releases the retained conversation gate at durable entry before notification while keeping the draft fixed', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const notificationDelivered = deferred<void>();
    const executed: string[] = [];
    const coordinator = createWorkflowCoordinator({ store, resolveWorkspace: async () => ({ ok: true, workspace }),
      isAcceptedAuthorizationCurrent: async () => true,
      onReviewEntered: async () => { await notificationDelivered.promise; }, executeStep: async (params) => {
        executed.push(params.step.id);
        await params.beforeInputAdmission();
        await params.onInputAccepted({ kind: 'detached_run', runId: 'native', localInputId: params.step.id,
          runtimeSelection: projectWorkflowRetainedRuntimeSelectionV1(params.execution) });
        if (params.step.id === 'later') notificationDelivered.resolve();
        return { kind: 'completed', result: params.step.id };
      } });
    const shared = { conversation: { kind: 'shared_run' as const } };
    const outcome = await coordinator.run({ runId: 'shared-review', definition: definition([{ kind: 'parallel', id: 'p', failurePolicy: 'fail_stop',
      branches: [{ id: 'a', blocks: [{ ...leaf('draft', true), execution: shared }] },
        { id: 'b', blocks: [{ ...leaf('later'), execution: shared }] }] }]), inputs: {}, executionTarget: { kind: 'detached_run' }, authorization });
    expect(outcome.state).toBe('waiting_for_review');
    expect(executed).toEqual(['draft', 'later']);
    expect([...store.records.values()].find((row) => row.blockId === 'draft')).toMatchObject({ lifecycle: 'waiting_for_review', result: 'draft' });
  });
  it('supplies exact draft publication context without changing authored inputs', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store, resolveWorkspace: async () => ({ ok: true, workspace }),
      isAcceptedAuthorizationCurrent: async () => true, executeStep: async (params) => {
        expect(params.input.text).toContain('workflow.run.invocations.publish_draft');
        expect(params.input.text).toContain('context-run');
        expect(params.input.text).toContain(params.invocationRecordId!);
        await params.beforeInputAdmission();
        await params.onInputAccepted({ kind: 'session', sessionId: 'session', localInputId: 'input' });
        return { kind: 'completed', result: 'draft' };
      } });
    expect((await coordinator.run({ runId: 'context-run', definition: definition([leaf('held', true)]),
      inputs: {}, executionTarget, authorization })).state).toBe('waiting_for_review');
    expect([...store.records.values()].find((row) => row.blockId === 'held')?.input?.document.text).toBe('held');
  });
  it.each(['completed', 'failed', 'cancelled', 'stop_pending'] as const)('consumes one generation intent through a same-conversation replacement (%s)', async (terminal) => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const key = workflowInvocationKey({ runId: 'generate', blockId: 'held', scope: [], attempt: 0 });
    await store.ensureIntent({ key, recordId: 'held-row', runId: 'generate', blockKind: 'step', blockId: 'held', memberOrdinal: '0',
      path: { blockId: 'held', scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
    await store.commitFact({ key, lifecycle: 'waiting_for_review', result: 'prior',
      execution: { kind: 'session', sessionId: 'session', localInputId: 'prior-input' }, workspace: { descriptor: workspace },
      review: { resultSource: { kind: 'execution_input' }, decision: { kind: 'generate', requestedFromContentRevision: '0' } } });
    const inputs: string[] = [];
    const coordinator = createWorkflowCoordinator({ store, resolveWorkspace: async () => ({ ok: true, workspace }),
      isAcceptedAuthorizationCurrent: async () => true, executeStep: async (params) => {
        inputs.push(params.invocationRecordId!);
        expect(params.recoveryPreviousExecution).toMatchObject({ sessionId: 'session', localInputId: 'prior-input' });
        expect(params.invocation.review).toBeUndefined();
        if (terminal !== 'cancelled') expect(params.invocation.observationDeadline).toBeUndefined();
        await params.beforeInputAdmission();
        await params.onInputAccepted({ kind: 'session', sessionId: 'session', localInputId: 'generated-input' }, 1000);
        return terminal === 'completed' ? { kind: 'completed', result: 'generated' }
          : terminal === 'failed' ? { kind: 'failed', code: 'provider_failed' }
          : terminal === 'stop_pending' ? { kind: 'needs_attention', code: 'session_input_result_read_failed' }
          : { kind: 'cancelled', code: 'provider_stopped' };
      } });
    const outcome = await coordinator.run({ runId: 'generate', definition: definition([{ ...leaf('held', true), timeoutMs: 100 }]), inputs: {}, executionTarget, authorization });
    expect(outcome.state).toBe(terminal === 'completed' ? 'succeeded' : terminal === 'stop_pending' ? 'interrupted' : 'waiting_for_review');
    expect(inputs).toHaveLength(1);
    const prior = store.records.get(key)!;
    expect(prior).toMatchObject({ lifecycle: 'superseded', result: 'prior', execution: { localInputId: 'prior-input' } });
    const replacement = [...store.records.values()].find((row) => row.attempt === 1)!;
    expect(replacement).toMatchObject({ previousAttemptRecordId: 'held-row',
      lifecycle: terminal === 'completed' ? 'completed' : terminal === 'stop_pending' ? 'needs_attention' : 'waiting_for_review' });
    expect(replacement.observationDeadline).toEqual({ kind: 'at', expiresAt: new Date(1100).toISOString() });
    if (terminal === 'completed') expect(replacement.result).toBe('generated');
  });

  it('reholds offline generation with a typed reason when retained workspace material is lost', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const authored = definition([leaf('held', true)]);
    const key = workflowInvocationKey({ runId: 'lost-generation', blockId: 'held', scope: [], attempt: 0 });
    await store.ensureIntent({ key, recordId: 'held-row', runId: 'lost-generation', blockKind: 'step', blockId: 'held', memberOrdinal: '0',
      path: { blockId: 'held', scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
    await store.commitFact({ key, lifecycle: 'waiting_for_review', result: 'prior',
      execution: { kind: 'detached_run', runId: 'native', localInputId: 'prior-input',
        runtimeSelection: projectWorkflowRetainedRuntimeSelectionV1({ ...authored.defaults, permissionMode: 'default' }) },
      review: { decision: { kind: 'generate', requestedFromContentRevision: '0' } } });
    let sent = false;
    const executeStep = createWorkflowDetachedExecutionRunStepExecutor({ workDepth: 0,
      actionExecutor: { execute: async () => { sent = true; throw new Error('lost_material_must_not_send'); } },
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      buildActionContext: () => ({ surface: 'rpc', authority: 'account_automation', callerPermissionMode: 'default' }) });
    const coordinator = createWorkflowCoordinator({ store, executeStep,
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true });
    expect((await coordinator.run({ runId: 'lost-generation', definition: authored, inputs: {},
      executionTarget: { kind: 'detached_run' }, authorization })).state).toBe('waiting_for_review');
    expect(sent).toBe(false);
    expect(store.records.get(key)).toMatchObject({ lifecycle: 'superseded', result: 'prior' });
    expect([...store.records.values()].find(row => row.attempt === 1)).toMatchObject({ lifecycle: 'waiting_for_review',
      reason: 'workflow_conversation_unavailable', previousAttemptRecordId: 'held-row' });
  });

  it.each(['session', 'detached_run'] as const)('allows an explicit second Generate after retained material is restored (%s)', async kind => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const authored = definition([leaf('held', true)]);
    const key = workflowInvocationKey({ runId: 'restored-generation', blockId: 'held', scope: [], attempt: 0 });
    await store.ensureIntent({ key, recordId: 'held-row', runId: 'restored-generation', blockKind: 'step', blockId: 'held', memberOrdinal: '0',
      logicalInvocationRecordId: 'held-row', path: { blockId: 'held', scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
    await store.commitFact({ key, lifecycle: 'waiting_for_review', result: 'prior', workspace: { descriptor: workspace },
      execution: kind === 'session' ? { kind, sessionId: 'conversation', localInputId: 'prior-input' }
        : { kind, runId: 'native', localInputId: 'prior-input',
            runtimeSelection: projectWorkflowRetainedRuntimeSelectionV1({ ...authored.defaults, permissionMode: 'default' }) },
      review: { decision: { kind: 'generate', requestedFromContentRevision: '0' } } });
    let restored = false;
    let admittedId = '';
    const conversations = createProductionWorkflowConversationOwner({ machineId: 'machine',
      createFreshConversation: async () => { throw new Error('generation_must_not_create_another_conversation'); },
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async ({ sessionId }) => restored
        ? { sessionId, machineId: 'machine', directory: '/repo', agentTarget: authored.defaults.agentTarget } : null });
    const executeStep = kind === 'session' ? createWorkflowSessionStepExecutor({ credentials: { token: 'token', encryption: null },
      prepareConversation: conversations.prepare,
      materializeConversation: async (prepared, params) => ({ ...(await conversations.materialize(prepared, params)),
        machineAdmissionTransport: async () => { throw new Error('injected_session_network_ports_own_transport'); } }),

      // Network-only ports: conversation selection, custody, rendering and result decoding remain real.
      sessionInput: { enqueue: async ({ sessionId, workflow }) => {
          expect(sessionId).toBe('conversation');
          admittedId = workflow.invocationRecordId;
          return { status: 'accepted', localId: admittedId };
        }, observe: async ({ sessionId, localId }) => ({ ok: true, sessionId, localId,
          result: { kind: 'final_text', text: 'generated' } }) } })
      : createWorkflowDetachedExecutionRunStepExecutor({ workDepth: 0,
        resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
        buildActionContext: () => ({ surface: 'rpc', authority: 'account_automation', callerPermissionMode: 'default' }),
        actionExecutor: { execute: async (actionId, input) => {
          if (actionId === 'execution.run.send') {
            if (!restored) return { ok: false, errorCode: 'execution_run_not_found', error: 'offline' };
            if (!input || typeof input !== 'object' || !('localInputId' in input)) throw new Error('missing_native_input');
            expect(input).toMatchObject({ runId: 'native' });
            admittedId = String(input.localInputId);
            return { ok: true, result: { ok: true } };
          }
          if (actionId === 'execution.run.get') return { ok: true, result: { run: { runId: 'native', callId: 'call', sidechainId: 'sidechain',
            intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'default',
            retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response', status: 'running', startedAtMs: 1,
            inputTurns: { occurrenceId: 'occurrence', last: { turnId: 'generated', inputIds: [admittedId], state: 'completed',
              result: { kind: 'text', value: 'generated' } } } } } };
          throw new Error(`unexpected_native_action:${actionId}`);
        } } });
    const coordinator = createWorkflowCoordinator({ store, executeStep,
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true });
    const params = { runId: 'restored-generation', definition: authored, inputs: {}, executionTarget: { kind }, authorization };
    expect((await coordinator.run(params)).state).toBe('waiting_for_review');
    const held = [...store.records.values()].find(row => row.attempt === 1)!;
    expect(held).toMatchObject({ lifecycle: 'waiting_for_review', reason: kind === 'session'
      ? 'workflow_conversation_unavailable' : 'continuation_unavailable', previousAttemptRecordId: 'held-row' });
    expect(held.execution).toBeUndefined();
    expect(admittedId).toBe('');
    restored = true;
    await store.commitFact({ key: held.key, lifecycle: 'waiting_for_review',
      review: { decision: { kind: 'generate', requestedFromContentRevision: held.contentRevision! } } });
    expect((await coordinator.run(params)).state).toBe('succeeded');
    expect([...store.records.values()].find(row => row.attempt === 2)).toMatchObject({ lifecycle: 'completed', result: 'generated',
      previousAttemptRecordId: held.recordId, execution: kind === 'session' ? { sessionId: 'conversation' } : { runId: 'native' } });
    expect(admittedId).not.toBe('prior-input');
    expect(store.records.get(key)).toMatchObject({ lifecycle: 'superseded', result: 'prior', execution: { localInputId: 'prior-input' } });
  });

  it.each([
    { errorCode: 'execution_run_not_found', reason: 'continuation_unavailable', lifecycle: 'waiting_for_review', state: 'waiting_for_review' },
    { errorCode: 'execution_run_not_allowed', reason: 'execution_run_not_allowed', lifecycle: 'waiting_for_review', state: 'waiting_for_review' },
    { errorCode: 'execution_run_send_outcome_unknown', reason: 'execution_run_send_outcome_unknown', lifecycle: 'outcome_uncertain', state: 'outcome_uncertain' },
    { errorCode: 'execution_run_initial_input_outcome_unknown', reason: 'execution_run_initial_input_outcome_unknown', lifecycle: 'needs_attention', state: 'interrupted' },
  ] as const)('preserves exact generation custody after a live retained owner refusal ($errorCode)', async (scenario) => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const authored = definition([leaf('held', true)]);
    const key = workflowInvocationKey({ runId: 'refused-generation', blockId: 'held', scope: [], attempt: 0 });
    await store.ensureIntent({ key, recordId: 'held-row', runId: 'refused-generation', blockKind: 'step', blockId: 'held', memberOrdinal: '0',
      path: { blockId: 'held', scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
    await store.commitFact({ key, lifecycle: 'waiting_for_review', result: 'prior', workspace: { descriptor: workspace },
      execution: { kind: 'detached_run', runId: 'native', localInputId: 'prior-input',
        runtimeSelection: projectWorkflowRetainedRuntimeSelectionV1({ ...authored.defaults, permissionMode: 'default' }) },
      review: { decision: { kind: 'generate', requestedFromContentRevision: '0' } } });
    const actions: string[] = [];
    const executeStep = createWorkflowDetachedExecutionRunStepExecutor({ workDepth: 0,
      actionExecutor: { execute: async (actionId) => {
        actions.push(actionId);
        return { ok: false, errorCode: scenario.errorCode, error: 'Retained owner refused input' };
      } }, resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      buildActionContext: () => ({ surface: 'rpc', authority: 'account_automation', callerPermissionMode: 'default' }) });
    const coordinator = createWorkflowCoordinator({ store, executeStep,
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true });
    expect((await coordinator.run({ runId: 'refused-generation', definition: authored, inputs: {},
      executionTarget: { kind: 'detached_run' }, authorization })).state).toBe(scenario.state);
    expect(actions).toEqual(['execution.run.send']);
    const current = [...store.records.values()].find(row => row.attempt === 1)!;
    expect(current).toMatchObject({ lifecycle: scenario.lifecycle, reason: scenario.reason });
    expect(current.execution).toBeUndefined();
    expect(store.records.get(key)).toMatchObject({ lifecycle: 'superseded', result: 'prior', execution: { localInputId: 'prior-input' } });
  });

  it('does not park while an executor terminal fact is still committing', async () => {
    const original = createInMemoryWorkflowCoordinatorStore();
    const committing = deferred<void>();
    const release = deferred<void>();
    let confirms = 0;
    const store = { ...original,
      commitFact: async (fact: Parameters<typeof original.commitFact>[0]) => {
        if (fact.key.includes(':slow:') && fact.lifecycle === 'completed') {
          committing.resolve();
          await release.promise;
        }
        return await original.commitFact(fact);
      },
      confirmReviewHolds: async (params: Parameters<typeof original.confirmReviewHolds>[0]) => {
        confirms += 1;
        return await original.confirmReviewHolds(params);
      },
    };
    const coordinator = createWorkflowCoordinator({ store, resolveWorkspace: async () => ({ ok: true, workspace }),
      isAcceptedAuthorizationCurrent: async () => true, executeStep: async (params) => {
        await params.beforeInputAdmission();
        await params.onInputAccepted({ kind: 'session', sessionId: params.step.id, localInputId: params.step.id });
        return { kind: 'completed', result: 'value' };
      } });
    const running = coordinator.run({ runId: 'handoff', definition: definition([{ kind: 'parallel', id: 'p', failurePolicy: 'fail_stop',
      branches: [{ id: 'a', blocks: [leaf('held', true)] }, { id: 'b', blocks: [leaf('slow')] }] }]),
      inputs: {}, executionTarget, authorization });
    await committing.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(confirms).toBe(0);
    release.resolve();
    expect((await running).state).toBe('waiting_for_review');
    expect(confirms).toBeGreaterThan(0);
  });

  it('keeps generated input in stop custody when Run cancellation has only requested the Session turn stop', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const key = workflowInvocationKey({ runId: 'cancel-generation', blockId: 'held', scope: [], attempt: 0 });
    await store.ensureIntent({ key, recordId: 'held-row', runId: 'cancel-generation', blockKind: 'step', blockId: 'held', memberOrdinal: '0',
      path: { blockId: 'held', scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
    await store.commitFact({ key, lifecycle: 'waiting_for_review', result: 'prior',
      execution: { kind: 'session', sessionId: 'session', localInputId: 'prior-input' }, workspace: { descriptor: workspace },
      review: { decision: { kind: 'generate', requestedFromContentRevision: '0' } } });
    const controller = new AbortController();
    let reviewEntries = 0;
    const coordinator = createWorkflowCoordinator({ store, resolveWorkspace: async () => ({ ok: true, workspace }),
      isAcceptedAuthorizationCurrent: async () => true, onReviewEntered: async () => { reviewEntries++; },
      executeStep: async (params) => {
        await params.beforeInputAdmission();
        await params.onInputAccepted({ kind: 'session', sessionId: 'session', localInputId: 'generated-input' });
        controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
        return { kind: 'needs_attention', code: 'session_input_result_read_failed' };
      } });
    expect(await coordinator.run({ runId: 'cancel-generation', definition: definition([leaf('held', true)]), inputs: {},
      executionTarget, authorization, signal: controller.signal })).toMatchObject({ state: 'interrupted' });
    expect([...store.records.values()].find((row) => row.attempt === 1)).toMatchObject({ lifecycle: 'needs_attention',
      execution: { localInputId: 'generated-input' } });
    expect(reviewEntries).toBe(0);
  });

  it('holds a successful initial turn whose required structured result is invalid', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store, resolveWorkspace: async () => ({ ok: true, workspace }),
      isAcceptedAuthorizationCurrent: async () => true, executeStep: async (params) => {
        await params.beforeInputAdmission();
        await params.onInputAccepted({ kind: 'session', sessionId: 'session', localInputId: 'input' });
        return { kind: 'completed', result: 'not JSON' };
      } });
    const outcome = await coordinator.run({ runId: 'invalid', definition: definition([{ ...leaf('held', true), result: { kind: 'json',
      schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } } }]),
      inputs: {}, executionTarget, authorization });
    expect(outcome.state).toBe('waiting_for_review');
    expect([...store.records.values()].find((row) => row.blockId === 'held')).toMatchObject({ lifecycle: 'waiting_for_review', reasonMessage: 'not_json' });
    expect([...store.records.values()].find((row) => row.blockId === 'held')?.result).toBeUndefined();
  });

  it('holds before its successor and parks with an immutable parent token', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const started: string[] = [];
    const coordinator = createWorkflowCoordinator({ store, resolveWorkspace: async () => ({ ok: true, workspace }),
      isAcceptedAuthorizationCurrent: async () => true, executeStep: async (params) => {
        started.push(params.step.id);
        await params.beforeInputAdmission();
        await params.onInputAccepted({ kind: 'session', sessionId: 'session', localInputId: params.step.id });
        return { kind: 'completed', result: 'draft' };
      } });
    const outcome = await coordinator.run({ runId: 'review', definition: definition([leaf('held', true), leaf('later')]),
      inputs: {}, executionTarget, authorization });
    expect(outcome).toMatchObject({ state: 'waiting_for_review', parkRevision: 0 });
    expect(started).toEqual(['held']);
    expect([...store.records.values()].find((row) => row.blockId === 'held')).toMatchObject({ lifecycle: 'waiting_for_review', result: 'draft' });
  });

  it('keeps a held slot occupied and never activates the capped sibling during park unwind', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const started: string[] = [];
    const coordinator = createWorkflowCoordinator({ store, resolveWorkspace: async () => ({ ok: true, workspace }),
      isAcceptedAuthorizationCurrent: async () => true, executeStep: async (params) => {
        started.push(params.step.id);
        await params.beforeInputAdmission();
        await params.onInputAccepted({ kind: 'session', sessionId: 'session', localInputId: params.step.id });
        return { kind: 'completed', result: 'draft' };
      } });
    const outcome = await coordinator.run({ runId: 'capped', definition: definition([{ kind: 'parallel', id: 'p', maxConcurrent: 1,
      failurePolicy: 'fail_stop', branches: [{ id: 'a', blocks: [leaf('held', true)] }, { id: 'b', blocks: [leaf('other')] }] }]),
      inputs: {}, executionTarget, authorization });
    expect(outcome.state).toBe('waiting_for_review');
    expect(started).toEqual(['held']);
    expect([...store.records.values()].find((row) => row.path.scope.some((part) => part.kind === 'branch' && part.branchId === 'b'))?.lifecycle)
      .toBe('waiting_for_capacity');
    expect([...store.records.values()].some((row) => row.reason?.startsWith('container_fail_stop'))).toBe(false);
  });

  it('resolves one hold while an independent dependency remains active without parking', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const slow = deferred<void>();
    const held = deferred<void>();
    const next = deferred<void>();
    const coordinator = createWorkflowCoordinator({ store, resolveWorkspace: async () => ({ ok: true, workspace }),
      isAcceptedAuthorizationCurrent: async () => true, executeStep: async (params) => {
        await params.beforeInputAdmission();
        await params.onInputAccepted({ kind: 'session', sessionId: params.step.id, localInputId: params.step.id });
        if (params.step.id === 'slow') await slow.promise;
        if (params.step.id === 'held') held.resolve();
        if (params.step.id === 'next') next.resolve();
        return { kind: 'completed', result: 'value' };
      } });
    const running = coordinator.run({ runId: 'live', definition: definition([{ kind: 'parallel', id: 'p', failurePolicy: 'fail_stop',
      branches: [{ id: 'a', blocks: [leaf('held', true), leaf('next')] }, { id: 'b', blocks: [leaf('slow')] }] }]),
      inputs: {}, executionTarget, authorization });
    await held.promise;
    // A macrotask lets the terminal capture commit through the real store.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const row = [...store.records.values()].find((record) => record.blockId === 'held')!;
    expect(row.lifecycle).toBe('waiting_for_review');
    await store.commitFact({ key: row.key, lifecycle: 'completed' });
    await coordinator.refreshReviewHolds();
    await next.promise;
    slow.resolve();
    expect((await running).state).toBe('succeeded');
  });

  it('Wait enters review without preparation, execution or workspace work', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const effects: string[] = [];
    const coordinator = createWorkflowCoordinator({ store, resolveWorkspace: async () => { effects.push('workspace'); return { ok: true, workspace }; },
      prepareStep: async () => { effects.push('prepare'); return {}; }, isAcceptedAuthorizationCurrent: async () => true,
      executeStep: async () => { effects.push('execute'); return { kind: 'completed', result: 'bad' }; } });
    const outcome = await coordinator.run({ runId: 'wait', definition: definition([{ kind: 'wait', id: 'person',
      document: { text: 'Please continue', references: [], attachments: [] }, result: { kind: 'text' } }]),
      inputs: {}, executionTarget, authorization });
    expect(outcome.state).toBe('waiting_for_review');
    expect(effects).toEqual([]);
    expect([...store.records.values()].find((row) => row.blockId === 'person')).toMatchObject({ lifecycle: 'waiting_for_review' });
  });
});
