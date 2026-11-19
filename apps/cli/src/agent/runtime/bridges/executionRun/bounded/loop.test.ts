import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { FinishExecutionRun } from '../executionRunFinishRun';
import type { ExecutionRunHostRuntime } from '../executionRunHostRuntime';
import type { ExecutionRunState } from '../executionRunTypes';
import { finishExecutionRun } from '../finishExecutionRun';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { executeBoundedBackendRun } from './loop';
import type { AgentRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { createNativeAgentSessionExecutionRunHostRuntime, createNativeAgentSessionInteractionHostRuntime } from '../nativeAgentExecutionRun';
import { createNativeSessionBoundary, createVoiceSessionContextLease } from '../testkit/nativeSessionContext';
import { projectRetainedExecutionRunState, RetainedExecutionRunRecordSchema } from '../retainedState';
import { ExecutionRunErrorSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { projectExecutionRunPublicState } from '../publicState';
import { createExecutionRunDiagnosticError, projectExecutionRunError } from '../errors';
import { reloadConfiguration } from '@/configuration';
import { readRetainedExecutionRunRecord } from '@/daemon/executionRunRegistry';
import { createExecutionRunControllerMessageHandler } from '../messages/sessionStateEmission';
import { enqueueExecutionRunMarkerWrite, writeExecutionRunActivityMarker } from '../activityMarkers';

function createController(backend: ExecutionRunHostRuntime, runtimeId: string): ExecutionRunBackendController {
  let resolveTerminal!: () => void;
  const terminalPromise = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  return {
    kind: 'backend',
    controllerOccurrenceId: `controller-${runtimeId}`,
    backend,
    backendSupportsResume: false,
    runtimeId,
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
    terminalPromise,
    resolveTerminal,
  };
}

function createRuntime(params: Partial<ExecutionRunHostRuntime>): ExecutionRunHostRuntime {
    return {
        async readResumeSupport() {
            return false;
    },
    async provisionRuntime() {
      return { runtimeId: 'child_session_1' };
    },
    async deliverInput() { return { status: 'admitted' }; },
    getRuntimeLifetimeSignal: () => new AbortController().signal,
    async cancel() {},
    subscribeMessages() {
      return () => {};
    },
    async dispose() {},
        ...params,
    };
}

describe('executeBoundedBackendRun', () => {
    it.each([true, false])('repairs prose through the native Session boundary (native schema supported=%s)', async selectedModelSupportsStructuredOutput => {
      const boundary = createNativeSessionBoundary();
      const state: ExecutionRunState = {
        runId: 'review-schema-run', callId: 'review-schema-call', sidechainId: 'review-schema-side', sessionId: null,
        depth: 0, intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
        instructions: 'Review the changed code', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
        runClass: 'bounded', ioMode: 'request_response', status: 'running', startedAtMs: 0,
      };
      const host = createNativeAgentSessionInteractionHostRuntime({
        runtime: { sessions: { open: boundary.open } },
        lease: { pluginId: 'acme.boundary', pluginVersion: '1.0.0', agentId: 'acme.boundary/default',
          localAgentId: 'default', occurrenceId: 'review-schema-fixture', isCurrent: () => true },
        options: { cwd: process.cwd(), runId: state.runId, scope: 'session_owned', backendId: 'acme.boundary/default',
          permissionMode: 'read_only', selectedModelSupportsStructuredOutput,
          start: { intent: 'review', runClass: 'bounded', retentionPolicy: 'ephemeral' } },
        sessionCapabilities: { open: ['create'], delivery: ['newTurn'], cancel: true },
        createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
      });
      const { runtimeId } = await host.provisionRuntime();
      const ctrl = createController(host, runtimeId);
      const runs = new Map([[state.runId, state]]);
      const controllers = new Map([[state.runId, ctrl]]);
      const unsubscribe = host.subscribeMessages(createExecutionRunControllerMessageHandler({
        ctrl, runId: state.runId, sidechainId: state.sidechainId, ioMode: state.ioMode,
        computeSidechainStreamText: text => text, sendAcp: async () => {}, parentProvider: 'codex', runs,
        backendSupportsResume: false, getNowMs: Date.now, writeActivityMarker: async () => {},
      }));
      const run = executeBoundedBackendRun({
        ...state, params: state, runs, controllers, sendAcp: async () => {}, parentProvider: 'codex',
        getNowMs: Date.now, boundedTimeoutMs: null,
        finishRun: async (runId, next, toolResult, structuredMeta) => {
          await finishExecutionRun({ runId, next, toolResult, structuredMeta, runs, controllers, budgetRegistry: null,
            parentProvider: 'codex', sendAcp: async () => {}, terminalMarkerWritePromises: new Map(),
            enqueueMarkerWrite: async () => {} });
        },
      });
      try {
        await boundary.waitForInputs(1);
        const input = boundary.inputs[0].input;
        if (selectedModelSupportsStructuredOutput) {
          expect(input).toHaveProperty('outputSchema.properties.findings');
          expect(input).toHaveProperty('outputSchema.properties.reviewOutcome');
          expect(input).not.toHaveProperty('outputSchema.properties.runRef');
          expect(input).toHaveProperty('outputSchema.properties.findings.items.additionalProperties', false);
          expect(input).toHaveProperty('outputSchema.properties.findings.items.properties.suggestion.anyOf',
            [expect.objectContaining({ type: 'string' }), { type: 'null' }]);
          expect(input).not.toHaveProperty('outputSchema.properties.findings.items.properties.comment');
          expect(input).not.toHaveProperty('outputSchema.properties.findings.items.properties.extensions');
        } else {
          expect(input).not.toHaveProperty('outputSchema');
        }
        boundary.complete('I inspected the code.');
        await Promise.race([boundary.waitForInputs(2), run]);
        expect(boundary.inputs).toHaveLength(2);
        boundary.complete(JSON.stringify({
          reviewOutcome: 'complete', summary: 'Review complete', overviewMarkdown: 'No actionable defects found',
          findings: [], questions: [], assumptions: [],
        }));
        await run;
        expect(runs.get(state.runId)).toMatchObject({ status: 'succeeded',
          structuredMeta: { kind: 'review_findings.v2', payload: { summary: 'Review complete', findings: [] } } });
      } finally {
        unsubscribe();
        await host.dispose();
      }
    });
    it.each([
      { completionDelayMs: 99, status: 'succeeded' },
      { completionDelayMs: 102, status: 'timeout' },
    ] as const)('retains native work at its authored boundary: $status', async ({ completionDelayMs, status }) => {
      const directory = await mkdtemp(join(tmpdir(), 'happier-run-boundary-'));
      vi.stubEnv('HAPPIER_HOME_DIR', directory);
      reloadConfiguration();
      vi.useFakeTimers({ now: 0 });
      // The canonical fixture controls only the external Agent SDK. Native
      // adaptation, message handling, terminalization and filesystem custody stay real.
      const boundary = createNativeSessionBoundary();
      const host = createNativeAgentSessionExecutionRunHostRuntime({
        runtime: { sessions: { open: boundary.open } },
        lease: { pluginId: 'acme.boundary', pluginVersion: '1.0.0', agentId: 'acme.boundary/default',
          localAgentId: 'default', occurrenceId: 'boundary-fixture', isCurrent: () => true },
        options: { cwd: directory, runId: 'boundary-run', scope: 'session_owned', backendId: 'acme.boundary/default',
          permissionMode: 'read_only', start: { intent: 'agent', runClass: 'bounded', retentionPolicy: 'ephemeral' } },
        supportsResume: false,
        createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
      });
      const { runtimeId } = await host.provisionRuntime();
      const ctrl = createController(host, runtimeId);
      const state: ExecutionRunState = {
        runId: 'boundary-run', callId: 'boundary-call', sidechainId: 'boundary-side', sessionId: null, depth: 0,
        intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
        instructions: 'work', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
        runClass: 'bounded', ioMode: 'request_response', status: 'running', startedAtMs: 0,
      };
      const runs = new Map([[state.runId, state]]);
      const controllers = new Map([[state.runId, ctrl]]);
      const markerWriteChains = new Map<string, Promise<void>>();
      const enqueueMarkerWrite = (runId: string, write: () => Promise<void>) =>
        enqueueExecutionRunMarkerWrite({ markerWriteChains, runId, write });
      const unsubscribe = host.subscribeMessages(createExecutionRunControllerMessageHandler({
        ctrl, runId: state.runId, sidechainId: state.sidechainId, ioMode: state.ioMode,
        computeSidechainStreamText: text => text, sendAcp: async () => {}, parentProvider: 'codex', runs,
        backendSupportsResume: false, getNowMs: Date.now,
        writeActivityMarker: (runId, nowMs, opts) => writeExecutionRunActivityMarker({
          runId, nowMs, opts, runs, controllers, enqueueMarkerWrite,
        }),
      }));
      const run = executeBoundedBackendRun({
        ...state, params: state, runs, controllers, sendAcp: async () => {},
        parentProvider: 'codex', getNowMs: Date.now, boundedTimeoutMs: 100,
        finishRun: async (runId, next, toolResult, structuredMeta) => {
          await finishExecutionRun({ runId, next, toolResult, structuredMeta, runs, controllers,
            budgetRegistry: null, parentProvider: 'codex', sendAcp: async () => {}, enqueueMarkerWrite,
            terminalMarkerWritePromises: new Map() });
        },
      });
      let completionTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await boundary.waitForInputs(1);
        completionTimer = setTimeout(() => boundary.complete('Completed work'), completionDelayMs);
        await vi.advanceTimersByTimeAsync(101);
        expect(runs.get(state.runId)?.status).toBe(status);
        await run;
        const retained = await readRetainedExecutionRunRecord(state.runId);
        expect(retained?.state.status).toBe(status);
        if (status === 'succeeded') expect(retained?.state.latestToolResult).toBe('Completed work');
        else expect(retained?.state.error?.code).toBe('provider_inactivity_timeout');
      } finally {
        clearTimeout(completionTimer);
        await vi.runAllTimersAsync();
        await run;
        unsubscribe();
        await host.dispose();
        vi.useRealTimers();
        vi.unstubAllEnvs();
        reloadConfiguration();
        await rm(directory, { recursive: true, force: true });
      }
    });

    it.each(['succeeded', 'cancelled'] as const)('clears an inherited typed failure when terminal commit is %s', async status => {
      const state: ExecutionRunState = { runId: 'run-stale-issue', callId: 'call', sidechainId: 'side', sessionId: null,
        depth: 0, intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
        instructions: 'work', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded',
        ioMode: 'request_response', status: 'running', startedAtMs: 0,
        // Exact-input observers may publish a failed turn before Run terminalization; Stop can win the commit.
        error: projectExecutionRunError(createExecutionRunDiagnosticError({ code: 'provider_usage_exhausted', severity: 'error',
          details: { runtimeAuthClassification: { kind: 'usage_limit', serviceId: 'openai-codex',
            source: 'structured_provider_error', resetsAtMs: 42_000 } } }, 20)),
      };
      const runs = new Map([[state.runId, state]]);
      await finishExecutionRun({ runId: state.runId, next: { status, finishedAtMs: 30 }, toolResult: { output: status },
        runs, controllers: new Map(), budgetRegistry: null, parentProvider: 'codex', sendAcp: async () => {},
        terminalMarkerWritePromises: new Map(), enqueueMarkerWrite: async () => {} });
      expect(runs.get(state.runId)?.status).toBe(status);
      expect(projectExecutionRunPublicState(runs.get(state.runId)!).error).toBeUndefined();
      expect(projectRetainedExecutionRunState(runs.get(state.runId)!).error).toBeUndefined();
    });

    it.each([
      ['finite', 42_000], ['finite', null], ['retained', 42_000], ['retained', null],
    ] as const)('retains the native %s usage-limit failure with reported reset %s', async (adapter, resetAtMs) => {
      let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
      // Installed Agent execution is the external boundary; admission, terminalization and readers stay real.
      const runtime: AgentRuntime = { sessions: { async open(sessionRequest) { return {
        async send(request) {
          emit!({ sessionId: sessionRequest.sessionId, sequence: 1, emittedAtMs: 10, kind: 'input-accepted',
            inputIds: request.inputIds, delivery: request.delivery });
          emit!({ sessionId: sessionRequest.sessionId, sequence: 2, emittedAtMs: 10, kind: 'turn-start',
            turnId: request.delivery.turnId, startedBy: 'host' });
          emit!({ sessionId: sessionRequest.sessionId, sequence: 3, emittedAtMs: 20, kind: 'turn-failed',
            turnId: request.delivery.turnId, diagnostic: { code: 'provider_usage_exhausted', severity: 'error',
              details: { runtimeAuthClassification: { kind: 'usage_limit', serviceId: 'openai-codex',
                quotaScope: 'account', source: 'structured_provider_error',
                ...(resetAtMs === null ? {} : { resetsAtMs: resetAtMs }) } } } });
          return { status: 'admitted' as const };
        },
        watch(listener) { emit = listener; return { dispose() {} }; }, async dispose() {},
      }; } } };
      const createHost = adapter === 'finite' ? createNativeAgentSessionExecutionRunHostRuntime : createNativeAgentSessionInteractionHostRuntime;
      const host = createHost({ runtime,
        lease: { pluginId: 'acme.limit', pluginVersion: '1.0.0', agentId: 'acme.limit/default',
          localAgentId: 'default', occurrenceId: 'limit-fixture', isCurrent: () => true },
        options: { cwd: '/repo', runId: 'run-limit', scope: 'session_owned', backendId: 'acme.limit/default',
          permissionMode: 'read_only', start: { intent: 'agent', runClass: 'bounded', retentionPolicy: 'ephemeral' } },
        supportsResume: false, sessionCapabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
        createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
      });
      const state: ExecutionRunState = { runId: 'run-limit', callId: 'call-limit', sidechainId: 'side-limit', sessionId: null,
        depth: 0, intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
        instructions: 'work', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded',
        ioMode: 'request_response', status: 'running', startedAtMs: 0 };
      const provisioned = await host.provisionRuntime();
      const controllers = new Map([[state.runId, createController(host, provisioned.runtimeId)]]);
      const runs = new Map([[state.runId, state]]);
      await executeBoundedBackendRun({ ...state, params: state, runs, controllers, parentProvider: 'codex',
        sendAcp: async () => {}, getNowMs: () => 30, boundedTimeoutMs: null,
        finishRun: async (runId, next, toolResult, structuredMeta) => {
          await finishExecutionRun({ runId, next, toolResult, structuredMeta, runs, controllers, budgetRegistry: null,
            parentProvider: 'codex', sendAcp: async () => {}, terminalMarkerWritePromises: new Map(),
            enqueueMarkerWrite: async () => {} });
        },
      });
      const finished = runs.get(state.runId)!;
      expect(finished, JSON.stringify(finished.error)).toMatchObject({ status: 'failed', error: { code: 'provider_usage_exhausted',
        runtimeIssueV1: { source: 'usage_limit', usageLimit: { resetAtMs } } } });
      const recovered = RetainedExecutionRunRecordSchema.parse(JSON.parse(JSON.stringify({ ownerPid: 1,
        terminalEventId: 'terminal-limit', state: projectRetainedExecutionRunState(finished) })));
      expect(recovered.state.error).toEqual(finished.error);
      expect(ExecutionRunErrorSchema.parse(projectExecutionRunPublicState(finished).error)).toEqual(finished.error);
    });

    it('retains the exact initial Agent result after bounded controller settlement', async () => {
      const runId = 'run-agent-result';
      let ctrl!: ExecutionRunBackendController;
      const runtime = createRuntime({
        async deliverInput() {
          ctrl.buffer = '{"changed":true}';
          return { status: 'admitted' as const };
        },
        async waitForTurnCompletion() {},
      });
      ctrl = createController(runtime, 'child-agent-result');
      const state: ExecutionRunState = {
        runId, callId: 'call-agent-result', sidechainId: 'side-agent-result', sessionId: null, depth: 0,
        intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
        instructions: 'implement', permissionMode: 'workspace_write', retentionPolicy: 'ephemeral',
        runClass: 'bounded', ioMode: 'request_response', status: 'running', startedAtMs: 0,
      };
      const runs = new Map([[runId, state]]);
      await executeBoundedBackendRun({
        runId, callId: state.callId, sidechainId: state.sidechainId, startedAtMs: 0,
        params: {
          ...state,
          localInputId: 'workflow-input-1',
          resultContract: {
            kind: 'json',
            schema: { type: 'object', properties: { changed: { type: 'boolean' } } },
          },
        },
        runs,
        controllers: new Map([[runId, ctrl]]),
        sendAcp: async () => {}, parentProvider: 'codex', getNowMs: () => 1,
        boundedTimeoutMs: null, finishRun: async () => {},
      });
      expect(runs.get(runId)?.inputTurns).toMatchObject({
        last: {
          inputIds: ['workflow-input-1'], state: 'completed',
          result: { kind: 'json', value: { changed: true } },
        },
      });
    });

    it('does not resume an interrupted replacement after its job timed out', async () => {
      let releaseCancel!: () => void;
      const cancellation = new Promise<void>((resolve) => { releaseCancel = resolve; });
      const deliverInput = vi.fn(async () => ({ status: 'admitted' as const }));
      const runtime = createRuntime({
        deliverInput, cancel: () => cancellation,
        waitForTurnCompletion: () => new Promise<void>(() => {}),
      });
      const ctrl = createController(runtime, 'child-timeout-replacement');
      const runId = 'run-timeout-replacement';
      const state: ExecutionRunState = {
        runId, callId: 'call', sidechainId: 'side', sessionId: 'session-parent', depth: 0,
        intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
        instructions: 'review', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
        runClass: 'bounded', ioMode: 'request_response', status: 'running', startedAtMs: 0,
      };
      const controllers = new Map([[runId, ctrl]]);
      const runs = new Map([[runId, state]]);
      ctrl.admittedLiveInterventions.push({ message: 'replacement', delivery: 'interrupt', resolve() {}, reject() {} });
      const run = executeBoundedBackendRun({
        runId, callId: 'call', sidechainId: 'side', startedAtMs: 0,
        params: {
          sessionId: 'session-parent', intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          instructions: 'review', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
          runClass: 'bounded', ioMode: 'request_response',
        },
        controllers, sendAcp: async () => {},
        parentProvider: 'codex', getNowMs: () => 1, boundedTimeoutMs: 1,
        finishRun: async (id, next, toolResult, structuredMeta) => {
          await finishExecutionRun({
            runId: id, next, toolResult, structuredMeta, runs, controllers, budgetRegistry: null,
            parentProvider: 'codex', sendAcp: async () => {}, terminalMarkerWritePromises: new Map(),
            // Persistence is external; host terminalization remains real.
            enqueueMarkerWrite: async () => {},
          });
        },
      });
      try {
        await run;
        expect(runs.get(runId)?.status).toBe('timeout');
        releaseCancel();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(deliverInput).toHaveBeenCalledOnce();
      } finally {
        releaseCancel();
      }
    });

    it('publishes timeout and retires host custody while provider cancellation never settles', async () => {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const runtime = createRuntime({
        cancel,
        waitForTurnCompletion: () => new Promise<void>(() => {}),
      });
      const runId = 'run-stalled-cancel';
      const ctrl = createController(runtime, 'child-stalled-cancel');
      const controllers = new Map([[runId, ctrl]]);
      const state: ExecutionRunState = {
        runId, callId: 'call-stalled-cancel', sidechainId: 'side-stalled-cancel',
        sessionId: 'parent-session', depth: 0, intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
        instructions: 'review', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
        runClass: 'bounded', ioMode: 'request_response', status: 'running', startedAtMs: 0,
      };
      const runs = new Map([[runId, state]]);
      const budgetRegistry = new ExecutionBudgetRegistry();
      expect(budgetRegistry.tryAcquireExecutionRun(runId)).toBe(true);
      let terminal = false;
      void ctrl.terminalPromise.then(() => { terminal = true; });
      const run = executeBoundedBackendRun({
        ...state, params: state, controllers, parentProvider: 'codex', getNowMs: () => 10,
        boundedTimeoutMs: 1, sendAcp: async () => {},
        finishRun: async (id, next, toolResult, structuredMeta) => {
          await finishExecutionRun({
            runId: id, next, toolResult, structuredMeta, runs, controllers, budgetRegistry,
            parentProvider: 'codex', sendAcp: async () => {}, terminalMarkerWritePromises: new Map(),
            // Marker persistence is the external boundary; terminal state, budget
            // release and controller settlement use their real owners.
            enqueueMarkerWrite: async () => {},
          });
        },
      });
      await vi.waitFor(() => expect(runs.get(runId)?.status).toBe('timeout'));
      await run;
      expect(cancel).toHaveBeenCalledWith('child-stalled-cancel');
      expect(terminal).toBe(true);
      expect(controllers.has(runId)).toBe(false);
      expect(budgetRegistry.tryAcquireExecutionRun('next-run')).toBe(true);
    });

    it('fails a refused typed input without waiting for a turn that was not admitted', async () => {
      const waitForTurnCompletion = vi.fn(async () => undefined);
      const runtime = createRuntime({
        async deliverInput() {
          return { status: 'rejected', diagnostic: { code: 'input_refused', severity: 'error' }, retryable: false };
        },
        waitForTurnCompletion,
      });
      const ctrl = createController(runtime, 'child-refused');
      const finishRun = vi.fn<FinishExecutionRun>();
      await executeBoundedBackendRun({
        runId: 'run-refused', callId: 'call-refused', sidechainId: 'side-refused', startedAtMs: 0,
        params: {
          sessionId: 'session-parent', intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          instructions: 'review', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
          runClass: 'bounded', ioMode: 'request_response',
        },
        controllers: new Map([['run-refused', ctrl]]), sendAcp: async () => {},
        parentProvider: 'codex', getNowMs: () => 1, boundedTimeoutMs: null, finishRun,
      });
      expect(waitForTurnCompletion).not.toHaveBeenCalled();
      expect(finishRun).toHaveBeenCalledWith('run-refused',
        expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'input_refused' }) }),
        expect.anything());
    });

    it('classifies an untyped post-invocation steer throw as outcome unknown', async () => {
      let completeTurn!: () => void;
      const turnCompletion = new Promise<void>((resolve) => {
        completeTurn = resolve;
      });
      let rejectSteer!: (error: Error) => void;
      const steerRejected = new Promise<Error>((resolve) => {
        rejectSteer = resolve;
      });
      const steerInput = vi.fn(async () => {
        throw new Error('provider response stream disconnected');
      });
      const runtime = createRuntime({
        steerInput,
        waitForTurnCompletion: async () => await turnCompletion,
      });
      const ctrl = createController(runtime, 'child-ambiguous-steer');
      ctrl.admittedLiveInterventions.push({
        message: 'effectful steer',
        delivery: 'steer_if_supported',
        resolve() {},
        reject: rejectSteer,
      });
      const execution = executeBoundedBackendRun({
        runId: 'run-ambiguous-steer',
        callId: 'call-ambiguous-steer',
        sidechainId: 'side-ambiguous-steer',
        startedAtMs: 0,
        params: {
          sessionId: null,
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          instructions: 'keep working',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        controllers: new Map([['run-ambiguous-steer', ctrl]]),
        sendAcp: async () => {},
        parentProvider: 'codex',
        getNowMs: () => 1,
        boundedTimeoutMs: null,
        finishRun: async () => {},
      });

      const error = await steerRejected;
      expect(error).toMatchObject({
        executionRunErrorCode: 'execution_run_send_outcome_unknown',
      });
      expect(ctrl.turnCancelReason).toBe('outcome_unknown');
      expect(ctrl.turnCancelEpoch).toBe(ctrl.turnEpoch);
      expect(steerInput).toHaveBeenCalledOnce();

      completeTurn();
      await execution;
    });

    it('allows retry after a typed pre-effect steer rejection', async () => {
      let completeTurn!: () => void;
      const turnCompletion = new Promise<void>((resolve) => {
        completeTurn = resolve;
      });
      const steerInput = vi.fn()
        .mockResolvedValueOnce({
          status: 'rejected' as const,
          diagnostic: { code: 'provider_busy', severity: 'error' as const },
          retryable: true,
        })
        .mockResolvedValueOnce({ status: 'admitted' as const });
      const runtime = createRuntime({
        steerInput,
        waitForTurnCompletion: async () => await turnCompletion,
      });
      const ctrl = createController(runtime, 'child-retryable-steer');
      const enqueue = (message: string): Promise<Error | null> => new Promise((resolve) => {
        ctrl.admittedLiveInterventions.push({
          message,
          delivery: 'steer_if_supported',
          resolve: () => resolve(null),
          reject: (error) => resolve(error),
        });
        ctrl.admittedLiveInterventionsSignal?.resolve();
        ctrl.admittedLiveInterventionsSignal = null;
      });
      const first = enqueue('first attempt');
      const execution = executeBoundedBackendRun({
        runId: 'run-retryable-steer',
        callId: 'call-retryable-steer',
        sidechainId: 'side-retryable-steer',
        startedAtMs: 0,
        params: {
          sessionId: null,
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          instructions: 'keep working',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        controllers: new Map([['run-retryable-steer', ctrl]]),
        sendAcp: async () => {},
        parentProvider: 'codex',
        getNowMs: () => 1,
        boundedTimeoutMs: null,
        finishRun: async () => {},
      });

      await expect(first).resolves.toMatchObject({ executionRunErrorCode: 'provider_busy' });
      expect(ctrl.turnCancelReason).toBeNull();
      await expect(enqueue('safe retry')).resolves.toBeNull();
      expect(steerInput).toHaveBeenCalledTimes(2);

      completeTurn();
      await execution;
    });

    it('preserves a structured review preflight failure as the canonical failed run result', async () => {
      const runtimeId = 'child_session_review_preflight';
      let ctrl!: ExecutionRunBackendController;
      const runtime = createRuntime({
        async deliverInput() {
          ctrl.buffer = JSON.stringify({
            status: 'failed',
            error: { code: 'deepsec_confirmation_required' },
            summary: 'DeepSec review requires confirmation.',
            overviewMarkdown: 'DeepSec review requires confirmation before launch.',
            findings: [],
            warning: { status: 'requires_confirmation', costClass: 'expensive' },
          });
          return { status: 'admitted' };
        },
        async waitForTurnCompletion() {},
      });
      ctrl = createController(runtime, runtimeId);
      const finishRun = vi.fn<FinishExecutionRun>();

      await executeBoundedBackendRun({
        runId: 'run_review_preflight_1',
        callId: 'subagent_run_review_preflight_1',
        sidechainId: 'subagent_run_review_preflight_1',
        startedAtMs: 0,
        params: {
          sessionId: 'parent_session_review_preflight',
          intent: 'review',
          backendTarget: { kind: 'builtInAgent', agentId: 'deepsec' },
          instructions: 'review it',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        controllers: new Map([['run_review_preflight_1', ctrl]]),
        sendAcp: async () => {},
        parentProvider: 'deepsec',
        getNowMs: () => 1,
        boundedTimeoutMs: null,
        finishRun,
      });

      expect(finishRun).toHaveBeenCalledWith(
        'run_review_preflight_1',
        expect.objectContaining({
          status: 'failed',
          summary: 'DeepSec review requires confirmation.',
          error: {
            code: 'deepsec_confirmation_required',
            message: 'DeepSec review requires confirmation.',
          },
        }),
        expect.objectContaining({
          output: expect.objectContaining({
            status: 'failed',
            error: { code: 'deepsec_confirmation_required' },
          }),
          isError: true,
        }),
        expect.objectContaining({
          kind: 'review_findings.v2',
          payload: expect.objectContaining({
            warning: { status: 'requires_confirmation', costClass: 'expensive' },
          }),
        }),
      );
    });

    it('keeps waiting past the bounded timeout when runtime liveness reports active work', async () => {
    const runtimeId = 'child_session_liveness_active';
    let ctrl!: ExecutionRunBackendController;
    const probeTurnLiveness = vi.fn(async () => ({
      active: true,
      reason: 'provider_turn_active',
    }));
    const cancel = vi.fn(async () => {});
    const runtime = createRuntime({
      async deliverInput() {
        ctrl.buffer = JSON.stringify({ findings: [], summary: 'ok' });
        return { status: 'admitted' };
      },
      cancel,
      async waitForTurnCompletion() {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 30);
        });
      },
    });
    Object.assign(runtime, { probeTurnLiveness });
    ctrl = createController(runtime, runtimeId);
    const finishRun = vi.fn<FinishExecutionRun>();

    await executeBoundedBackendRun({
      runId: 'run_liveness_active_1',
      callId: 'subagent_run_liveness_active_1',
      sidechainId: 'subagent_run_liveness_active_1',
      startedAtMs: 0,
      params: {
        sessionId: 'parent_session_liveness_active',
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        instructions: 'review it',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      controllers: new Map([['run_liveness_active_1', ctrl]]),
      sendAcp: async () => {},
      parentProvider: 'codex',
      getNowMs: () => 1,
      boundedTimeoutMs: 10,
      finishRun,
    });

    expect(probeTurnLiveness).toHaveBeenCalledWith(runtimeId);
    expect(cancel).not.toHaveBeenCalled();
        expect(finishRun).toHaveBeenCalledWith(
            'run_liveness_active_1',
            expect.objectContaining({ status: 'succeeded' }),
            expect.objectContaining({
                output: expect.objectContaining({ status: 'succeeded' }),
            }),
            expect.objectContaining({ kind: 'review_findings.v2' }),
        );
    });

    it('times out when the bounded wait elapses without backend liveness proof', async () => {
        const runtimeId = 'child_session_no_liveness_proof';
        const cancel = vi.fn(async () => {});
        const runtime = createRuntime({
            cancel,
            async waitForTurnCompletion() {
                await new Promise<void>(() => {});
            },
        });
        const ctrl = createController(runtime, runtimeId);
        const finishRun = vi.fn<FinishExecutionRun>();
        await executeBoundedBackendRun({
            runId: 'run_no_liveness_proof_1',
            callId: 'subagent_run_no_liveness_proof_1',
            sidechainId: 'subagent_run_no_liveness_proof_1',
            startedAtMs: 0,
            params: {
                sessionId: 'parent_session_no_liveness_proof',
                intent: 'review',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                instructions: 'review it',
                permissionMode: 'read_only',
                retentionPolicy: 'ephemeral',
                runClass: 'bounded',
                ioMode: 'request_response',
            },
            controllers: new Map([['run_no_liveness_proof_1', ctrl]]),
            sendAcp: async () => {},
            parentProvider: 'codex',
            getNowMs: () => 1,
            boundedTimeoutMs: 10,
            finishRun,
        });

        expect(cancel).toHaveBeenCalledWith(runtimeId);
        expect(finishRun).toHaveBeenCalledWith(
            'run_no_liveness_proof_1',
            expect.objectContaining({
                status: 'timeout',
                error: expect.objectContaining({ code: 'provider_inactivity_timeout' }),
            }),
            expect.objectContaining({
                output: expect.objectContaining({
                    status: 'timeout',
                    error: expect.objectContaining({ code: 'provider_inactivity_timeout' }),
                }),
                isError: true,
            }),
        );
    });

    it('classifies typed provider wait timeouts as execution-run timeouts', async () => {
    const runtimeId = 'child_session_typed_provider_timeout';
    const livenessProbe = { active: false, reason: 'provider_idle' };
    const providerTimeout = Object.assign(new Error('Timed out after 250ms'), {
      executionRunErrorCode: 'provider_inactivity_timeout',
      livenessProbe,
    });
    const cancel = vi.fn(async () => {});
    const runtime = createRuntime({
      cancel,
      async waitForTurnCompletion() {
        throw providerTimeout;
      },
    });
    const ctrl = createController(runtime, runtimeId);
    const finishRun = vi.fn<FinishExecutionRun>();

    await executeBoundedBackendRun({
      runId: 'run_typed_provider_timeout_1',
      callId: 'subagent_run_typed_provider_timeout_1',
      sidechainId: 'subagent_run_typed_provider_timeout_1',
      startedAtMs: 0,
      params: {
        sessionId: 'parent_session_typed_provider_timeout',
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        instructions: 'review it',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      controllers: new Map([['run_typed_provider_timeout_1', ctrl]]),
      sendAcp: async () => {},
      parentProvider: 'codex',
      getNowMs: () => 1,
      boundedTimeoutMs: 250,
      finishRun,
    });

    expect(cancel).toHaveBeenCalledWith(runtimeId);
    expect(finishRun).toHaveBeenCalledWith(
      'run_typed_provider_timeout_1',
      expect.objectContaining({
        status: 'timeout',
        error: expect.objectContaining({ code: 'provider_inactivity_timeout' }),
      }),
      expect.objectContaining({
        output: expect.objectContaining({
          status: 'timeout',
          error: expect.objectContaining({ code: 'provider_inactivity_timeout' }),
          livenessProbe,
        }),
        isError: true,
      }),
    );
  });

  it('preserves a non-timeout typed controller failure in the terminal result', async () => {
    const runtimeId = 'child_session_output_limit';
    const outputLimit = Object.assign(new Error('Execution-run task output exceeded the configured limit.'), {
      executionRunErrorCode: 'execution_run_output_limit_exceeded',
    });
    const runtime = createRuntime({
      async waitForTurnCompletion() {
        throw outputLimit;
      },
    });
    const ctrl = createController(runtime, runtimeId);
    const finishRun = vi.fn<FinishExecutionRun>();

    await executeBoundedBackendRun({
      runId: 'run_output_limit_1',
      callId: 'subagent_run_output_limit_1',
      sidechainId: 'subagent_run_output_limit_1',
      startedAtMs: 0,
      params: {
        sessionId: null,
        intent: 'task',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        instructions: 'produce output',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      controllers: new Map([['run_output_limit_1', ctrl]]),
      sendAcp: async () => {},
      parentProvider: 'codex',
      getNowMs: () => 1,
      boundedTimeoutMs: null,
      finishRun,
    });

    expect(finishRun).toHaveBeenCalledWith(
      'run_output_limit_1',
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({ code: 'execution_run_output_limit_exceeded' }),
      }),
      expect.objectContaining({
        output: expect.objectContaining({
          status: 'failed',
          error: expect.objectContaining({ code: 'execution_run_output_limit_exceeded' }),
        }),
        isError: true,
      }),
    );
  });
});
