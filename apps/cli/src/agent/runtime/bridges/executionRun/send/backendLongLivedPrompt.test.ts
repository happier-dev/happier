import { describe, expect, it, vi } from 'vitest';
import { materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';

import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import {
  createTestExecutionRunHostRuntime,
  type TestExecutionRunHostRuntimeActions,
} from '@/agent/runtime/bridges/executionRun/testkit/runtime';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { sendBackendLongLivedRun } from '@/agent/runtime/bridges/executionRun/send/backendLongLivedPrompt';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import { failureSignal } from '@/agent/executionRuns/controllers/failureSignal';
import { createExecutionRunCodedError } from '@/agent/runtime/bridges/executionRun/errors';
import { createExactTurnUsageAccumulator } from '@/usage/exactTurnUsage';
import { createRuntimeTurnFailureAlreadySurfacedError } from '@/agent/runtime/turns/runtimeTurnOperations';
import { settleExecutionRunController } from '../settleExecutionRunController';
import { projectExecutionRunPublicState } from '../publicState';
import { observeWorkflowDetachedExecutionRunInput } from '@/daemon/workflows/stepExecution';

function createResumableBackendHarness(): Readonly<{
  runtime: ExecutionRunHostRuntime;
  setSendPrompt: (
    sendPrompt: (runtimeId: string, prompt: string, actions: TestExecutionRunHostRuntimeActions) => Promise<void> | void,
  ) => void;
}> {
  let sendPromptImpl: (runtimeId: string, prompt: string, actions: TestExecutionRunHostRuntimeActions) => Promise<void> | void = () => undefined;
  const harness = createTestExecutionRunHostRuntime({
    async provisionRuntime(opts) {
      return { runtimeId: opts?.resumeRuntimeId ? 'child_runtime_loaded' : 'child_runtime_started' };
    },
    sendPrompt: async (runtimeId, prompt, actions) => {
      await sendPromptImpl(runtimeId, prompt, actions);
    },
  });

  return {
    runtime: harness.runtime,
    setSendPrompt(next) {
      sendPromptImpl = next;
    },
  };
}

function createLongLivedResumableRun(overrides?: Partial<ExecutionRunState>): ExecutionRunState {
  return {
    runId: 'run_1',
    callId: 'call_1',
    sidechainId: 'sidechain_1',
    sessionId: 'parent_session_1',
    depth: 0,
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: 'acme.runtime.backend' as never },
    backendId: 'acme.runtime.backend',
    instructions: '',
    permissionMode: 'read_only',
    retentionPolicy: 'resumable',
    runClass: 'long_lived',
    ioMode: 'request_response',
    status: 'cancelled',
    startedAtMs: 1_700_000_000_000,
    resumeHandle: {
      kind: 'provider_session.v1',
      backendTarget: { kind: 'backend', backendId: 'acme.runtime.backend', sourceKind: 'built_in' },
      providerSessionId: 'vendor_session_1',
    },
    ...(overrides ?? {}),
  };
}

describe('sendBackendLongLivedRun (resume)', () => {
  it.each(['matching', 'other'] as const)('settles detached continuation activity with a %s input claim', async (claim) => {
    let finishTurn!: () => void;
    const completed = new Promise<void>(resolve => { finishTurn = resolve; });
    const { runtime } = createTestExecutionRunHostRuntime({
      deliverInput: async () => ({ status: 'admitted' }),
      waitForTurnCompletion: async () => await completed,
    });
    const run = createLongLivedResumableRun({ sessionId: null, status: 'running' });
    const controller: ExecutionRunBackendController = {
      kind: 'backend', controllerOccurrenceId: 'detached-continuation', backend: runtime, backendSupportsResume: true,
      runtimeId: 'native', buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '', streamWriter: null,
      cancelled: false, turnCount: 1, turnEpoch: 1, turnInFlight: false, turnCancelReason: null, turnCancelEpoch: null,
      admittedLiveInterventions: [], admittedLiveInterventionsSignal: null, lastMarkerWriteAtMs: 0,
      pendingHostBarrier: Promise.resolve(), terminalPromise: Promise.resolve(), resolveTerminal: () => {},
      // The profile publisher retains this exact input across continuation preparation/admission.
      pendingHostInput: claim === 'matching' ? 'walkthrough-input' : 'another-input',
    };
    const runs = new Map([[run.runId, run]]);
    try {
      await expect(sendBackendLongLivedRun({ runId: run.runId,
        params: { message: 'Continue', localInputId: 'walkthrough-input' }, runs,
        controllers: new Map([[run.runId, controller]]), budgetRegistry: null,
        createRuntime: () => runtime, maxTurns: null, getNowMs: () => 9_000, finishRun: async () => {},
        sendAcp: async () => {}, parentProvider: 'codex', streamedTranscriptSession: null, writeActivityMarker: async () => {},
      })).resolves.toEqual({ ok: true });
      expect(projectExecutionRunPublicState(runs.get(run.runId)!, controller)).toMatchObject({
        status: 'running', runClass: 'long_lived', turnInFlight: true,
      });
      finishTurn();
      await vi.waitFor(() => expect(controller.lastInputTurn).toMatchObject({ state: 'completed' }));
      expect(projectExecutionRunPublicState(runs.get(run.runId)!, controller)).toMatchObject({
        status: 'running', runClass: 'long_lived', turnInFlight: claim !== 'matching', lifecycle: { state: 'current' },
      });
      expect(controller.pendingHostInput).toBe(claim === 'matching' ? undefined : 'another-input');
    } finally {
      finishTurn();
      await runtime.dispose();
    }
  });

  it('resumes a terminal Run through a new occurrence while the previous controller is settling', async () => {
    let releaseMarker!: () => void;
    const terminalMarker = new Promise<void>((resolve) => { releaseMarker = resolve; });
    const oldInputs: string[] = [];
    const { runtime: oldRuntime } = createTestExecutionRunHostRuntime({
      sendPrompt: (_id, prompt) => { oldInputs.push(prompt); },
    });
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => { resolveTerminal = resolve; });
    const run = createLongLivedResumableRun({ status: 'succeeded' });
    const oldController: ExecutionRunBackendController = {
      kind: 'backend', controllerOccurrenceId: 'terminal-occurrence', backend: oldRuntime,
      backendSupportsResume: true, runtimeId: 'old-runtime', buffer: '', sidechainStreamBuffer: '',
      sidechainStreamKey: '', streamWriter: null, cancelled: false, turnCount: 1, turnEpoch: 1,
      turnInFlight: false, turnCancelReason: null, turnCancelEpoch: null,
      admittedLiveInterventions: [], admittedLiveInterventionsSignal: null, lastMarkerWriteAtMs: 0,
      failureSignal: failureSignal(), pendingHostBarrier: Promise.resolve(),
      terminalMarkerWritePromise: terminalMarker, terminalPromise, resolveTerminal,
    };
    const controllers = new Map([[run.runId, oldController]]);
    const settling = settleExecutionRunController({ runId: run.runId, controller: oldController, controllers });
    const newInputs: string[] = [];
    const { runtime } = createTestExecutionRunHostRuntime({
      runtimeId: 'resumed-runtime', sendPrompt: (_id, prompt) => { newInputs.push(prompt); },
    });
    const runs = new Map([[run.runId, run]]);
    try {
      const sending = sendBackendLongLivedRun({
        runId: run.runId, params: { message: 'Continue', resume: true }, runs, controllers,
        budgetRegistry: null, createRuntime: () => runtime, maxTurns: null, getNowMs: () => 123,
        finishRun: async () => {}, sendAcp: async () => {}, parentProvider: 'codex',
        streamedTranscriptSession: null, writeActivityMarker: async () => {},
      });
      // The native occurrence cannot be replaced before its terminal marker settles.
      await Promise.resolve();
      expect(oldInputs).toEqual([]);
      expect(newInputs).toEqual([]);
      releaseMarker();
      await expect(sending).resolves.toEqual({ ok: true });
      expect(newInputs).toEqual(['Continue']);
      expect(oldInputs).toEqual([]);
      expect(runs.get(run.runId)?.status).toBe('running');
      const resumedController = controllers.get(run.runId);
      expect(resumedController).not.toBe(oldController);
      await settling;
      expect(controllers.get(run.runId)).toBe(resumedController);
    } finally {
      releaseMarker();
      await settling;
      await runtime.dispose();
    }
  });

  it('admits a new public retained input with its own Run ceiling instead of reusing an opener authority', async () => {
    const deliverInput = vi.fn<ExecutionRunHostRuntime['deliverInput']>(async () => ({ status: 'admitted' as const }));
    const { runtime } = createTestExecutionRunHostRuntime({ deliverInput });
    const run = createLongLivedResumableRun({ sessionId: null });
    await expect(sendBackendLongLivedRun({ runId: run.runId, params: { message: 'Read the workspace', resume: true },
      runs: new Map([[run.runId, run]]), controllers: new Map(), budgetRegistry: null, createRuntime: () => runtime,
      maxTurns: null, getNowMs: () => 123, finishRun: async () => {}, sendAcp: async () => {}, parentProvider: 'codex',
      streamedTranscriptSession: null, writeActivityMarker: async () => {},
    })).resolves.toEqual({ ok: true });
    expect(deliverInput.mock.calls[0]?.[2]).toMatchObject({
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
    });
  });

  it.each(['initial', 'retained'])('projects native acceptance of a detached %s Workflow input before acknowledging send', async (inputKind) => {
    type RuntimeEvent = Parameters<NonNullable<ExecutionRunHostRuntime['subscribeRuntimeEvents']>>[0] extends (event: infer E) => void ? E : never;
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const observations: unknown[] = [];
    const sink = { commit: async (observation: unknown) => { observations.push(observation); } };
    const { runtime: baseRuntime } = createTestExecutionRunHostRuntime({
      deliverInput: async (_id, _input, meta) => {
        for (const listener of listeners) listener({ kind: 'input-accepted', sessionId: 'native', sequence: 1,
          emittedAtMs: 2_000, inputIds: [meta!.localId!], delivery: { kind: 'newTurn', turnId: 'native-turn' } });
        return { status: 'admitted' };
      },
      waitForTurnCompletion: async () => await new Promise<void>(() => {}),
    });
    const runtime: ExecutionRunHostRuntime = { ...baseRuntime,
      subscribeRuntimeEvents: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    const run = createLongLivedResumableRun({ sessionId: null, status: 'running' });
    const localInputId = `workflow-${inputKind}`;
    const controller: ExecutionRunBackendController = {
      kind: 'backend', controllerOccurrenceId: 'detached-acceptance', backend: runtime, backendSupportsResume: true,
      runtimeId: 'native', buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '', streamWriter: null,
      cancelled: false, turnCount: 0, turnEpoch: 0, turnInFlight: false, turnCancelReason: null, turnCancelEpoch: null,
      admittedLiveInterventions: [], admittedLiveInterventionsSignal: null, lastMarkerWriteAtMs: 0,
      pendingHostBarrier: Promise.resolve(), terminalPromise: Promise.resolve(), resolveTerminal: () => {},
      ...(inputKind === 'initial' ? { workflowObservation: { localInputId, sink, usage: createExactTurnUsageAccumulator() } } : {}),
    };
    await expect(sendBackendLongLivedRun({ runId: run.runId,
      params: { message: 'Generate', localInputId, ...(inputKind === 'retained' ? { workflowObservationSink: sink } : {}) },
      runs: new Map([[run.runId, run]]), controllers: new Map([[run.runId, controller]]), budgetRegistry: null,
      createRuntime: () => runtime, maxTurns: null, getNowMs: () => 9_000, finishRun: async () => {},
      sendAcp: async () => {}, parentProvider: 'codex', streamedTranscriptSession: null, writeActivityMarker: async () => {},
    })).resolves.toEqual({ ok: true });
    expect(observations).toEqual([{ kind: 'input_accepted', runId: run.runId, localInputId, acceptedAtMs: 2_000 }]);
    // A prior turn's listener may still be settling when the next binding appears.
    controller.workflowObservation = { localInputId: 'next-input', sink, usage: createExactTurnUsageAccumulator() };
    for (const listener of listeners) listener({ kind: 'input-accepted', sessionId: 'native', sequence: 2,
      emittedAtMs: 3_000, inputIds: ['next-input'], delivery: { kind: 'newTurn', turnId: 'next-turn' } });
    await controller.pendingHostBarrier;
    expect(observations).toHaveLength(1);
    await runtime.dispose();
    expect(listeners.size).toBe(0);
  });

  it.each(['interaction_capacity', 'usage_limit'] as const)('preserves a typed %s failure in the Run terminal witness', async kind => {
    const errorCode = kind === 'interaction_capacity' ? 'workflow_interaction_capacity_exceeded' : 'provider_usage_exhausted';
    const completionError = kind === 'interaction_capacity' ? Object.assign(
      createExecutionRunCodedError(
        'workflow_interaction_capacity_exceeded',
        'Workflow interaction exceeds durable capacity',
      ),
      { code: 'workflow_interaction_capacity_exceeded', recoverable: true as const },
    ) : createRuntimeTurnFailureAlreadySurfacedError({ message: 'Usage limit reached', event: {
      kind: 'turn-failed', sessionId: 'native', sequence: 3, emittedAtMs: 100, turnId: 'native-turn',
      diagnostic: { code: errorCode, severity: 'error', details: { runtimeAuthClassification: {
        kind: 'usage_limit', serviceId: 'openai-codex', source: 'structured_provider_error', resetsAtMs: 42_000,
      } } },
    } });
    const { runtime } = createTestExecutionRunHostRuntime({
      deliverInput: async () => ({ status: 'admitted' as const }),
      waitForTurnCompletion: async () => { throw completionError; },
    });
    const run = createLongLivedResumableRun({ status: 'running' });
    const runs = new Map([[run.runId, run]]);
    let resolveFinish!: () => void;
    const finishPending = new Promise<void>(resolve => { resolveFinish = resolve; });
    const finishRun = vi.fn(async (_runId: string, _next: unknown) => await finishPending);
    const controller: ExecutionRunBackendController = {
      kind: 'backend', controllerOccurrenceId: 'long-lived-capacity', backend: runtime, backendSupportsResume: true,
      runtimeId: 'child_runtime_active', buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '',
      streamWriter: null, cancelled: false, turnCount: 0, turnEpoch: 0, turnInFlight: false,
      turnCancelReason: null, turnCancelEpoch: null, admittedLiveInterventions: [], admittedLiveInterventionsSignal: null,
      lastMarkerWriteAtMs: 0, failureSignal: failureSignal(), pendingHostBarrier: Promise.resolve(),
      terminalPromise: new Promise<void>(() => {}), resolveTerminal: () => undefined,
    };
    const failedTurnBusyStates: boolean[] = [];
    try {
      await expect(sendBackendLongLivedRun({
        runId: run.runId,
        params: { message: 'Continue', localInputId: 'workflow-input-1' },
        runs,
        controllers: new Map([[run.runId, controller]]),
        budgetRegistry: null,
        createRuntime: () => runtime,
        maxTurns: null,
        getNowMs: () => 123,
        finishRun,
        sendAcp: async () => {},
        parentProvider: 'codex',
        streamedTranscriptSession: null,
        writeActivityMarker: async () => undefined,
        onPublicStateUpdated: () => {
          if (controller.lastInputTurn?.state === 'failed') failedTurnBusyStates.push(controller.turnInFlight);
        },
      })).resolves.toEqual({ ok: true });
      await vi.waitFor(() => expect(finishRun).toHaveBeenCalledOnce());
      expect(finishRun.mock.calls[0]?.[1]).toMatchObject({
        status: 'failed',
        error: { code: errorCode, ...(kind === 'usage_limit' ? {
          runtimeIssueV1: { source: 'usage_limit', usageLimit: { resetAtMs: 42_000 } },
        } : {}) },
      });
      expect(controller.currentInputTurn).toBeUndefined();
      expect(controller.lastInputTurn).toMatchObject({ inputIds: ['workflow-input-1'], state: 'failed' });
      expect(controller.turnInFlight).toBe(false);
      expect(failedTurnBusyStates).toContain(false);
      expect(failedTurnBusyStates).not.toContain(true);
      expect(runs.get(run.runId)?.error).toMatchObject({ code: errorCode,
        ...(kind === 'usage_limit' ? { runtimeIssueV1: { usageLimit: { resetAtMs: 42_000 } } } : {}) });
    } finally { resolveFinish(); }
  });

  it('waits for the retained initial Pending admission before delivering an immediate follow-up', async () => {
    const deliveryOrder: string[] = [];
    let resolveInitialAdmission!: (value: 'accepted') => void;
    const initialPendingInputAdmission = new Promise<'accepted'>((resolve) => {
      resolveInitialAdmission = resolve;
    });
    const deliverInput = vi.fn(async () => {
      deliveryOrder.push('follow-up');
      return { status: 'admitted' as const };
    });
    const { runtime } = createTestExecutionRunHostRuntime({
      deliverInput,
      waitForTurnCompletion: async () => undefined,
    });
    const run = createLongLivedResumableRun({ status: 'running' });
    const runs = new Map([[run.runId, run]]);
    const controller: ExecutionRunBackendController = {
      kind: 'backend', controllerOccurrenceId: 'long-lived-controller-1', backend: runtime, backendSupportsResume: true,
      runtimeId: 'child_runtime_active', buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '',
      streamWriter: null, cancelled: false, turnCount: 0, turnEpoch: 0, turnInFlight: false,
      turnCancelReason: null, turnCancelEpoch: null, admittedLiveInterventions: [], admittedLiveInterventionsSignal: null,
      lastMarkerWriteAtMs: 0, failureSignal: failureSignal(), pendingHostBarrier: Promise.resolve(),
      initialPendingInputAdmission,
      terminalPromise: new Promise<void>(() => {}), resolveTerminal: () => {},
    };
    const controllers = new Map([[run.runId, controller]]);

    const sending = sendBackendLongLivedRun({
      runId: run.runId,
      params: { message: 'Follow-up work.' },
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => runtime,
      maxTurns: null,
      getNowMs: () => 123,
      finishRun: async () => undefined,
      sendAcp: async () => {},
      parentProvider: 'codex',
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(deliverInput).not.toHaveBeenCalled();

    deliveryOrder.push('initial');
    resolveInitialAdmission('accepted');
    await expect(sending).resolves.toEqual({ ok: true });
    expect(deliveryOrder).toEqual(['initial', 'follow-up']);
    expect(deliverInput).toHaveBeenCalledExactlyOnceWith(
      'child_runtime_active',
      { text: 'Follow-up work.' },
      undefined,
    );
  });

  it.each(['raw', 'fenced'])('keeps the authored input identity and validated %s result on the exact settled turn', async encoding => {
    let controller!: ExecutionRunBackendController;
    const deliverInput = vi.fn(async () => {
      controller.buffer = encoding === 'fenced' ? '```json\n{"changed":true}\n```' : '{"changed":true}';
      return { status: 'admitted' as const };
    });
    const { runtime } = createTestExecutionRunHostRuntime({
      deliverInput,
      waitForTurnCompletion: async () => undefined,
    });
    const run = createLongLivedResumableRun({ status: 'running', intent: 'agent' });
    const runs = new Map([[run.runId, run]]);
    controller = {
      kind: 'backend', controllerOccurrenceId: 'long-lived-result-turn', backend: runtime, backendSupportsResume: true,
      runtimeId: 'child_runtime_active', buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '',
      streamWriter: null, cancelled: false, turnCount: 0, turnEpoch: 0, turnInFlight: false,
      turnCancelReason: null, turnCancelEpoch: null, admittedLiveInterventions: [], admittedLiveInterventionsSignal: null,
      lastMarkerWriteAtMs: 0, failureSignal: failureSignal(), pendingHostBarrier: Promise.resolve(),
      terminalPromise: new Promise<void>(() => {}), resolveTerminal: () => {},
    };
    const controllers = new Map([[run.runId, controller]]);
    const resultContract = {
      kind: 'json' as const,
      schema: { type: 'object' as const, properties: { changed: { type: 'boolean' as const } } },
    };

    await expect(sendBackendLongLivedRun({
      runId: run.runId,
      params: { message: 'Implement it.', localInputId: 'workflow-input-1', resultContract },
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => runtime,
      maxTurns: null,
      getNowMs: () => 123,
      finishRun: async () => undefined,
      sendAcp: async () => {},
      parentProvider: 'codex',
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
    })).resolves.toEqual({ ok: true });

    await vi.waitFor(() => expect(controller.lastInputTurn).toMatchObject({
      inputIds: ['workflow-input-1'],
      state: 'completed',
      result: { kind: 'json', value: { changed: true } },
    }));
    expect(runs.get(run.runId)?.inputTurns).toMatchObject({
      last: {
        inputIds: ['workflow-input-1'],
        state: 'completed',
        result: { kind: 'json', value: { changed: true } },
      },
    });
    expect(deliverInput).toHaveBeenCalledWith(
      'child_runtime_active',
      { text: expect.stringContaining('required result schema') },
      { localId: 'workflow-input-1', resultContract },
    );
  });

  it('leaves the settled turn\'s text on the public read the daemon observes', async () => {
    let controller!: ExecutionRunBackendController;
    const { runtime } = createTestExecutionRunHostRuntime({
      deliverInput: async () => {
        controller.buffer = 'Final turn text';
        return { status: 'admitted' as const };
      },
      waitForTurnCompletion: async () => undefined,
    });
    const run = createLongLivedResumableRun({ status: 'running', intent: 'agent' });
    const runs = new Map([[run.runId, run]]);
    controller = {
      kind: 'backend', controllerOccurrenceId: 'long-lived-text-turn', backend: runtime, backendSupportsResume: true,
      runtimeId: 'child_runtime_active', buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '',
      streamWriter: null, cancelled: false, turnCount: 0, turnEpoch: 0, turnInFlight: false,
      turnCancelReason: null, turnCancelEpoch: null, admittedLiveInterventions: [], admittedLiveInterventionsSignal: null,
      lastMarkerWriteAtMs: 0, failureSignal: failureSignal(), pendingHostBarrier: Promise.resolve(),
      terminalPromise: new Promise<void>(() => {}), resolveTerminal: () => {},
    };

    await expect(sendBackendLongLivedRun({
      runId: run.runId, params: { message: 'Implement it.', localInputId: 'workflow-input-1' }, runs,
      controllers: new Map([[run.runId, controller]]), budgetRegistry: null, createRuntime: () => runtime, maxTurns: null,
      getNowMs: () => 123, finishRun: async () => undefined, sendAcp: async () => {}, parentProvider: 'codex',
      streamedTranscriptSession: null, writeActivityMarker: async () => undefined,
    })).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(controller.lastInputTurn?.state).toBe('completed'));

    await expect(observeWorkflowDetachedExecutionRunInput({
      runId: run.runId, localInputId: 'workflow-input-1',
      get: async () => ({ run: projectExecutionRunPublicState(runs.get(run.runId)!, controller) }),
    })).resolves.toEqual({ kind: 'completed', result: 'Final turn text' });
  });

  it('binds a fresh Workflow interaction store only to the exact active input turn and releases it at retirement', async () => {
    let controller!: ExecutionRunBackendController;
    const releaseResponseTarget = vi.fn();
    const store = {
      publishRequest: vi.fn(),
      registerResponseTargetHandler: vi.fn(() => releaseResponseTarget),
    };
    const { runtime } = createTestExecutionRunHostRuntime({
      deliverInput: async () => {
        expect(controller.currentInputPermissionRequestStore).toMatchObject({
          localInputId: 'workflow-input-b',
          store,
        });
        return { status: 'admitted' as const };
      },
      waitForTurnCompletion: async () => undefined,
    });
    const run = createLongLivedResumableRun({ status: 'running', sessionId: null, intent: 'agent' });
    const runs = new Map([[run.runId, run]]);
    controller = {
      kind: 'backend', controllerOccurrenceId: 'controller-reconstructed-b', backend: runtime, backendSupportsResume: true,
      runtimeId: 'child_runtime_active', buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '',
      streamWriter: null, cancelled: false, turnCount: 1, turnEpoch: 1, turnInFlight: false,
      turnCancelReason: null, turnCancelEpoch: null, admittedLiveInterventions: [], admittedLiveInterventionsSignal: null,
      lastMarkerWriteAtMs: 0, failureSignal: failureSignal(), pendingHostBarrier: Promise.resolve(),
      terminalPromise: new Promise<void>(() => {}), resolveTerminal: () => {},
    };

    await expect(sendBackendLongLivedRun({
      runId: run.runId,
      params: { message: 'Second step', localInputId: 'workflow-input-b' },
      runs,
      controllers: new Map([[run.runId, controller]]),
      budgetRegistry: null,
      createRuntime: () => runtime,
      maxTurns: null,
      getNowMs: () => 123,
      finishRun: async () => undefined,
      sendAcp: async () => {},
      parentProvider: 'codex',
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      permissionRequestStore: store as never,
      handlePermissionResponseTarget: async () => true,
    })).resolves.toEqual({ ok: true });

    expect(store.registerResponseTargetHandler).toHaveBeenCalledTimes(1);
    expect(releaseResponseTarget).toHaveBeenCalledTimes(1);
    expect(controller.currentInputPermissionRequestStore).toBeUndefined();
  });

  it('preserves a typed non-admission without reporting success or ending a resumable Run', async () => {
    const deliverInput = vi.fn(async () => ({
      status: 'unavailable' as const,
      diagnostic: { code: 'provider_busy', message: 'Provider is busy', severity: 'error' as const },
      retryable: true,
    }));
    const steerInput = vi.fn(async () => ({
      status: 'unsupported' as const,
      diagnostic: { code: 'steer_unavailable', message: 'Steering is unavailable', severity: 'error' as const },
      retryable: false,
    }));
    const { runtime } = createTestExecutionRunHostRuntime({ deliverInput, steerInput });
    const run = createLongLivedResumableRun();
    const runs = new Map([[run.runId, run]]);
    const controllers = new Map<string, ExecutionRunBackendController>();
    const finishRun = vi.fn(async () => undefined);
    const causalPermissionAuthority = { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const };
    const actionRequestAttributionV1 = materializeActionRequestAttributionV1({ requestRef: 'resumed-request',
      requester: { serverId: 'home', accountId: 'bob' }, persona: { serverId: 'home', sessionId: 'bot-session' }, origin: null });
    const args = {
      runId: run.runId, params: { message: 'try this', resume: true, causalPermissionAuthority, actionRequestAttributionV1, effectiveCallerPermissionMode: 'read-only' }, runs, controllers,
      budgetRegistry: null, createRuntime: () => runtime, maxTurns: null, getNowMs: () => 123,
      finishRun, sendAcp: async () => {}, parentProvider: 'codex' as const, streamedTranscriptSession: null,
      writeActivityMarker: async () => {},
    };
    const result = await sendBackendLongLivedRun(args);
    expect(deliverInput).toHaveBeenCalledWith('test_runtime_1', { text: 'try this' }, { causalPermissionAuthority, actionRequestAttributionV1, effectiveCallerPermissionMode: 'read-only' });
    expect(result).toEqual({ ok: false, errorCode: 'provider_busy', error: 'Provider is busy' });
    expect(finishRun).not.toHaveBeenCalled();
    expect(controllers.get(run.runId)?.turnInFlight).toBe(false);
    expect(controllers.get(run.runId)?.turnCount).toBe(0);
    const controller = controllers.get(run.runId)!;
    controller.turnInFlight = true;
    expect(await sendBackendLongLivedRun({ ...args, params: { ...args.params, delivery: 'steer_if_supported' } }))
      .toEqual({ ok: false, errorCode: 'steer_unavailable', error: 'Steering is unavailable' });
    expect(steerInput).toHaveBeenCalledWith('test_runtime_1', { text: 'try this' }, { causalPermissionAuthority, actionRequestAttributionV1, effectiveCallerPermissionMode: 'read-only' });
    expect(controller.turnInFlight).toBe(true);
    expect(finishRun).not.toHaveBeenCalled();
  });
  it('forwards tool-call events after resuming a long-lived run (no fresh-vs-resume divergence)', async () => {
    const sendAcp = vi.fn(async (..._args: unknown[]) => {});
    const { runtime, setSendPrompt } = createResumableBackendHarness();
    setSendPrompt((_runtimeId, _prompt, actions) => {
      actions.emit({ type: 'tool-call', toolName: 'bash', callId: 'call_123', args: { command: 'ls' } });
    });

    const run = createLongLivedResumableRun();
    const runs = new Map([[run.runId, run]]);
    const controllers = new Map();

    const res = await sendBackendLongLivedRun({
      runId: run.runId,
      params: { message: 'hi', resume: true },
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => runtime,
      maxTurns: null,
      getNowMs: () => 123,
      finishRun: async () => undefined,
      sendAcp,
      parentProvider: 'acme.runtime.provider' as any,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
    });

    expect(res).toEqual({ ok: true });
    expect(sendAcp.mock.calls.some((call) => (call[1] as any)?.type === 'tool-call')).toBe(true);
  });

  it('does not allow bypassing maxTurns by resuming (turnCount must be cumulative)', async () => {
    const { runtime } = createResumableBackendHarness();

    const run = createLongLivedResumableRun({ turnCount: 2 });
    const runs = new Map([[run.runId, run]]);
    const controllers = new Map();

    const res = await sendBackendLongLivedRun({
      runId: run.runId,
      params: { message: 'hi', resume: true },
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => runtime,
      maxTurns: 2,
      getNowMs: () => 123,
      finishRun: async () => undefined,
      sendAcp: async () => {},
      parentProvider: 'acme.runtime.provider' as any,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('execution_run_not_allowed');
    expect(res.error).toBe('Turn limit exceeded');
  });

  it('checks connected-service generation after resume and before sending to the provider', async () => {
    const { runtime, setSendPrompt } = createResumableBackendHarness();
    const sendPrompt = vi.fn();
    setSendPrompt(sendPrompt);
    const run = createLongLivedResumableRun();
    const runs = new Map([[run.runId, run]]);
    const controllers = new Map();

    const res = await sendBackendLongLivedRun({
      runId: run.runId,
      params: { message: 'hi', resume: true },
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => runtime,
      maxTurns: null,
      getNowMs: () => 123,
      finishRun: async () => undefined,
      sendAcp: async () => {},
      parentProvider: 'acme.runtime.provider' as any,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      authorizeProviderEffect: async () => {
        expect(controllers.has(run.runId)).toBe(true);
        return {
          ok: false,
          errorCode: 'execution_run_connected_service_generation_refresh_required',
          error: 'Connected-service credentials changed. Restart or resume this execution run before sending.',
        };
      },
    });

    expect(res).toEqual({
      ok: false,
      errorCode: 'execution_run_connected_service_generation_refresh_required',
      error: 'Connected-service credentials changed. Restart or resume this execution run before sending.',
    });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('keeps custody after an effectful send has an ambiguous AbortError until canonical completion', async () => {
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const providerEffects: string[] = [];
    const sendPrompt = vi.fn(async (_runtimeId: string, prompt: string) => {
      providerEffects.push(prompt);
      if (providerEffects.length === 1) {
        throw Object.assign(new Error('prompt outcome is ambiguous'), { name: 'AbortError' });
      }
    });
    const sendSteerPrompt = vi.fn(async () => undefined);
    const { runtime } = createTestExecutionRunHostRuntime({
      sendPrompt,
      sendSteerPrompt,
      waitForTurnCompletion: async () => await completion,
    });
    const run = createLongLivedResumableRun({ status: 'running' });
    const runs = new Map([[run.runId, run]]);
    const controller: ExecutionRunBackendController = {
      kind: 'backend',
      controllerOccurrenceId: 'long-lived-controller-2',
      backend: runtime,
      backendSupportsResume: true,
      runtimeId: 'child_runtime_active',
      buffer: '',
      sidechainStreamBuffer: '',
      sidechainStreamKey: '',
      streamWriter: null,
      cancelled: false,
      turnCount: 0,
      turnEpoch: 0,
      turnInFlight: false,
      turnCancelReason: null,
      turnCancelEpoch: null,
      admittedLiveInterventions: [],
      admittedLiveInterventionsSignal: null,
      lastMarkerWriteAtMs: 0,
      failureSignal: failureSignal(),
      pendingHostBarrier: Promise.resolve(),
      terminalPromise: new Promise<void>(() => {}),
      resolveTerminal: () => undefined,
    };
    const controllers = new Map([[run.runId, controller]]);

    const sendArgs = {
      runId: run.runId,
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => runtime,
      maxTurns: null,
      getNowMs: () => 123,
      finishRun: async () => undefined,
      sendAcp: async () => {},
      parentProvider: 'acme.runtime.provider' as any,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
    } as const;

    const result = await sendBackendLongLivedRun({
      ...sendArgs,
      params: { message: 'first', delivery: 'steer_if_supported' },
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'execution_run_send_outcome_unknown' });
    expect(providerEffects).toEqual(['first']);
    expect(sendPrompt).toHaveBeenCalledOnce();
    expect(controller.turnInFlight).toBe(true);
    expect(controller.turnCancelReason).toBe('outcome_unknown');

    await expect(sendBackendLongLivedRun({
      ...sendArgs,
      params: { message: 'must not overlap', delivery: 'steer_if_supported' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
    expect(sendPrompt).toHaveBeenCalledOnce();
    expect(sendSteerPrompt).not.toHaveBeenCalled();

    resolveCompletion();
    await vi.waitFor(() => {
      expect(controller.turnInFlight).toBe(false);
      expect(controller.turnCancelReason).toBeNull();
    });

    await expect(sendBackendLongLivedRun({
      ...sendArgs,
      params: { message: 'after completion', delivery: 'steer_if_supported' },
    })).resolves.toEqual({ ok: true });
    expect(providerEffects).toEqual(['first', 'after completion']);
  });

  it('does not release ambiguous send custody when the completion observer also aborts', async () => {
    const sendPrompt = vi.fn(async () => {
      throw Object.assign(new Error('send outcome is ambiguous'), { name: 'AbortError' });
    });
    const { runtime } = createTestExecutionRunHostRuntime({
      sendPrompt,
      waitForTurnCompletion: async () => {
        throw Object.assign(new Error('completion observation was cancelled'), { name: 'AbortError' });
      },
    });
    const run = createLongLivedResumableRun({ status: 'running' });
    const runs = new Map([[run.runId, run]]);
    const controller: ExecutionRunBackendController = {
      kind: 'backend',
      controllerOccurrenceId: 'long-lived-controller-3',
      backend: runtime,
      backendSupportsResume: true,
      runtimeId: 'child_runtime_active',
      buffer: '',
      sidechainStreamBuffer: '',
      sidechainStreamKey: '',
      streamWriter: null,
      cancelled: false,
      turnCount: 0,
      turnEpoch: 0,
      turnInFlight: false,
      turnCancelReason: null,
      turnCancelEpoch: null,
      admittedLiveInterventions: [],
      admittedLiveInterventionsSignal: null,
      lastMarkerWriteAtMs: 0,
      failureSignal: failureSignal(),
      pendingHostBarrier: Promise.resolve(),
      terminalPromise: new Promise<void>(() => {}),
      resolveTerminal: () => undefined,
    };
    const controllers = new Map([[run.runId, controller]]);
    const sendArgs = {
      runId: run.runId,
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => runtime,
      maxTurns: null,
      getNowMs: () => 123,
      finishRun: async () => undefined,
      sendAcp: async () => {},
      parentProvider: 'acme.runtime.provider' as any,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
    } as const;

    await expect(sendBackendLongLivedRun({
      ...sendArgs,
      params: { message: 'first' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_send_outcome_unknown' });

    await vi.waitFor(() => {
      expect(controller.turnCancelReason).toBe('outcome_unknown');
    });
    expect(controller.turnInFlight).toBe(true);
    await expect(sendBackendLongLivedRun({
      ...sendArgs,
      params: { message: 'must remain blocked' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
    expect(sendPrompt).toHaveBeenCalledOnce();
  });

  it('keeps custody when an effectful send throws an untyped error', async () => {
    const deliverInput = vi.fn(async () => {
      throw new Error('provider response was lost');
    });
    const { runtime } = createTestExecutionRunHostRuntime({ deliverInput });
    const run = createLongLivedResumableRun({ status: 'running' });
    const runs = new Map([[run.runId, run]]);
    const finishRun = vi.fn(async () => undefined);
    const controller: ExecutionRunBackendController = {
      kind: 'backend', controllerOccurrenceId: 'long-lived-controller-4', backend: runtime, backendSupportsResume: true,
      runtimeId: 'child_runtime_active', buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '',
      streamWriter: null, cancelled: false, turnCount: 0, turnEpoch: 0, turnInFlight: false,
      turnCancelReason: null, turnCancelEpoch: null, admittedLiveInterventions: [], admittedLiveInterventionsSignal: null,
      lastMarkerWriteAtMs: 0, failureSignal: failureSignal(), pendingHostBarrier: Promise.resolve(),
      terminalPromise: new Promise<void>(() => {}), resolveTerminal: () => undefined,
    };
    const controllers = new Map([[run.runId, controller]]);
    const sendArgs = {
      runId: run.runId,
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => runtime,
      maxTurns: null,
      getNowMs: () => 123,
      finishRun,
      sendAcp: async () => {},
      parentProvider: 'codex' as const,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
    } as const;

    await expect(sendBackendLongLivedRun({
      ...sendArgs,
      params: { message: 'perform once' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_send_outcome_unknown',
      error: 'The prompt may have been accepted before the provider response failed',
    });

    expect(deliverInput).toHaveBeenCalledOnce();
    expect(finishRun).not.toHaveBeenCalled();
    expect(runs.get(run.runId)?.status).toBe('running');
    expect(controller.turnInFlight).toBe(true);
    expect(controller.turnCancelReason).toBe('outcome_unknown');
    await expect(sendBackendLongLivedRun({
      ...sendArgs,
      params: { message: 'must not redrive' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
    expect(deliverInput).toHaveBeenCalledOnce();
  });

  it('keeps existing turn custody when an effectful steer throws an untyped error', async () => {
    const steerInput = vi.fn(async () => {
      throw new Error('steer response was lost');
    });
    const { runtime } = createTestExecutionRunHostRuntime({ steerInput });
    const run = createLongLivedResumableRun({ status: 'running' });
    const runs = new Map([[run.runId, run]]);
    const finishRun = vi.fn(async () => undefined);
    const controller: ExecutionRunBackendController = {
      kind: 'backend', controllerOccurrenceId: 'long-lived-controller-5', backend: runtime, backendSupportsResume: true,
      runtimeId: 'child_runtime_active', buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '',
      streamWriter: null, cancelled: false, turnCount: 1, turnEpoch: 1, turnInFlight: true,
      turnCancelReason: null, turnCancelEpoch: null, admittedLiveInterventions: [], admittedLiveInterventionsSignal: null,
      lastMarkerWriteAtMs: 0, failureSignal: failureSignal(), pendingHostBarrier: Promise.resolve(),
      terminalPromise: new Promise<void>(() => {}), resolveTerminal: () => undefined,
    };
    const controllers = new Map([[run.runId, controller]]);
    const sendArgs = {
      runId: run.runId,
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => runtime,
      maxTurns: null,
      getNowMs: () => 123,
      finishRun,
      sendAcp: async () => {},
      parentProvider: 'codex' as const,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
    } as const;

    await expect(sendBackendLongLivedRun({
      ...sendArgs,
      params: { message: 'steer once', delivery: 'steer_if_supported' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_send_outcome_unknown',
      error: 'The steer may have been accepted before the provider response failed',
    });

    expect(steerInput).toHaveBeenCalledOnce();
    expect(finishRun).not.toHaveBeenCalled();
    expect(runs.get(run.runId)?.status).toBe('running');
    expect(controller.turnInFlight).toBe(true);
    expect(controller.turnCancelReason).toBe('outcome_unknown');
    expect(controller.turnCancelEpoch).toBe(1);
    await expect(sendBackendLongLivedRun({
      ...sendArgs,
      params: { message: 'must not resteer', delivery: 'steer_if_supported' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
    expect(steerInput).toHaveBeenCalledOnce();
  });

  it('keeps an owner-proven pre-effect rejection retryable without acquiring turn custody', async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const { runtime } = createTestExecutionRunHostRuntime({ sendPrompt });
    const run = createLongLivedResumableRun({ status: 'running' });
    const runs = new Map([[run.runId, run]]);
    const controller: ExecutionRunBackendController = {
      kind: 'backend',
      controllerOccurrenceId: 'long-lived-controller-6',
      backend: runtime,
      backendSupportsResume: true,
      runtimeId: 'child_runtime_active',
      buffer: '',
      sidechainStreamBuffer: '',
      sidechainStreamKey: '',
      streamWriter: null,
      cancelled: false,
      turnCount: 0,
      turnEpoch: 0,
      turnInFlight: false,
      turnCancelReason: null,
      turnCancelEpoch: null,
      admittedLiveInterventions: [],
      admittedLiveInterventionsSignal: null,
      lastMarkerWriteAtMs: 0,
      failureSignal: failureSignal(),
      pendingHostBarrier: Promise.resolve(),
      terminalPromise: new Promise<void>(() => {}),
      resolveTerminal: () => undefined,
    };
    const controllers = new Map([[run.runId, controller]]);
    const authorizeProviderEffect = vi.fn()
      .mockResolvedValueOnce({ ok: false, errorCode: 'permission_denied', error: 'Denied before effect' })
      .mockResolvedValueOnce({ ok: true });
    const sendArgs = {
      runId: run.runId,
      params: { message: 'retryable' },
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => runtime,
      maxTurns: null,
      getNowMs: () => 123,
      finishRun: async () => undefined,
      sendAcp: async () => {},
      parentProvider: 'acme.runtime.provider' as any,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      authorizeProviderEffect,
    } as const;

    await expect(sendBackendLongLivedRun(sendArgs)).resolves.toEqual({
      ok: false,
      errorCode: 'permission_denied',
      error: 'Denied before effect',
    });
    expect(controller.turnInFlight).toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();

    await expect(sendBackendLongLivedRun(sendArgs)).resolves.toEqual({ ok: true });
    expect(sendPrompt).toHaveBeenCalledOnce();
  });
});
