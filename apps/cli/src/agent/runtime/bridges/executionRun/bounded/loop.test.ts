import { describe, expect, it, vi } from 'vitest';

import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { SessionId } from '@/agent/core/AgentMessage';
import type { FinishExecutionRun } from '../executionRunFinishRun';
import type { ExecutionRunHostRuntime } from '../executionRunHostRuntime';
import { executeBoundedBackendRun } from './loop';

function createController(backend: ExecutionRunHostRuntime, childSessionId: SessionId): ExecutionRunBackendController {
  let resolveTerminal!: () => void;
  const terminalPromise = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  return {
    kind: 'backend',
    backend,
    backendSupportsResume: false,
    childSessionId,
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
    pendingExternalMessages: [],
    pendingExternalMessagesSignal: null,
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
    async provisionSession() {
      return { sessionId: 'child_session_1' };
    },
    async sendPrompt() {},
    async cancel() {},
    subscribeMessages() {
      return () => {};
    },
    async dispose() {},
        ...params,
    };
}

describe('executeBoundedBackendRun', () => {
    it('preserves a structured review preflight failure as the canonical failed run result', async () => {
      const childSessionId = 'child_session_review_preflight' as SessionId;
      let ctrl!: ExecutionRunBackendController;
      const runtime = createRuntime({
        async sendPrompt() {
          ctrl.buffer = JSON.stringify({
            status: 'failed',
            error: { code: 'deepsec_confirmation_required' },
            summary: 'DeepSec review requires confirmation.',
            overviewMarkdown: 'DeepSec review requires confirmation before launch.',
            findings: [],
            warning: { status: 'requires_confirmation', costClass: 'expensive' },
          });
        },
        async waitForTurnCompletion() {},
      });
      ctrl = createController(runtime, childSessionId);
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
    const childSessionId = 'child_session_liveness_active' as SessionId;
    let ctrl!: ExecutionRunBackendController;
    const probeTurnLiveness = vi.fn(async () => ({
      active: true,
      reason: 'provider_turn_active',
    }));
    const cancel = vi.fn(async () => {});
    const runtime = createRuntime({
      async sendPrompt() {
        ctrl.buffer = JSON.stringify({ findings: [], summary: 'ok' });
      },
      cancel,
      async waitForTurnCompletion() {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 30);
        });
      },
    });
    Object.assign(runtime, { probeTurnLiveness });
    ctrl = createController(runtime, childSessionId);
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

    expect(probeTurnLiveness).toHaveBeenCalledWith(childSessionId);
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
        const childSessionId = 'child_session_no_liveness_proof' as SessionId;
        const cancel = vi.fn(async () => {});
        const runtime = createRuntime({
            cancel,
            async waitForTurnCompletion() {
                await new Promise<void>(() => {});
            },
        });
        const ctrl = createController(runtime, childSessionId);
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

        expect(cancel).toHaveBeenCalledWith(childSessionId);
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
    const childSessionId = 'child_session_typed_provider_timeout' as SessionId;
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
    const ctrl = createController(runtime, childSessionId);
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

    expect(cancel).toHaveBeenCalledWith(childSessionId);
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
    const childSessionId = 'child_session_output_limit' as SessionId;
    const outputLimit = Object.assign(new Error('Execution-run task output exceeded the configured limit.'), {
      executionRunErrorCode: 'execution_run_output_limit_exceeded',
    });
    const runtime = createRuntime({
      async waitForTurnCompletion() {
        throw outputLimit;
      },
    });
    const ctrl = createController(runtime, childSessionId);
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
