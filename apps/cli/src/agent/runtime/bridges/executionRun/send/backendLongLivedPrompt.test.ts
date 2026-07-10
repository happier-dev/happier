import { describe, expect, it, vi } from 'vitest';

import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import {
  createTestExecutionRunHostRuntime,
  type TestExecutionRunHostRuntimeActions,
} from '@/agent/runtime/bridges/executionRun/testkit/runtime';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { sendBackendLongLivedRun } from '@/agent/runtime/bridges/executionRun/send/backendLongLivedPrompt';

function createResumableBackendHarness(): Readonly<{
  runtime: ExecutionRunHostRuntime;
  setSendPrompt: (
    sendPrompt: (sessionId: string, prompt: string, actions: TestExecutionRunHostRuntimeActions) => Promise<void> | void,
  ) => void;
}> {
  let sendPromptImpl: (sessionId: string, prompt: string, actions: TestExecutionRunHostRuntimeActions) => Promise<void> | void = () => undefined;
  const harness = createTestExecutionRunHostRuntime({
    async provisionSession(opts) {
      return { sessionId: opts?.resumeSessionId ? 'child_session_loaded' : 'child_session_started' };
    },
    sendPrompt: async (sessionId, prompt, actions) => {
      await sendPromptImpl(sessionId, prompt, actions);
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
  it('forwards tool-call events after resuming a long-lived run (no fresh-vs-resume divergence)', async () => {
    const sendAcp = vi.fn();
    const { runtime, setSendPrompt } = createResumableBackendHarness();
    setSendPrompt((_sessionId, _prompt, actions) => {
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
      finishRun: () => undefined,
      sendAcp: sendAcp as any,
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
      finishRun: () => undefined,
      sendAcp: (() => undefined) as any,
      parentProvider: 'acme.runtime.provider' as any,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('execution_run_not_allowed');
    expect(res.error).toBe('Turn limit exceeded');
  });
});
