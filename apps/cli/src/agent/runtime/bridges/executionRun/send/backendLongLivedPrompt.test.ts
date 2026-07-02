import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, SessionId, StartSessionResult } from '@/agent/core/AgentBackend';
import { createExecutionRunHostRuntimeFromAgentBackend } from '@/agent/runtime/bridges/executionRun/testkit';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { sendBackendLongLivedRun } from '@/agent/runtime/bridges/executionRun/send/backendLongLivedPrompt';

function createResumableBackendHarness(): Readonly<{
  backend: AgentBackend;
  emit: (msg: any) => void;
}> {
  let handler: ((msg: any) => void) | null = null;
  const emit = (msg: any) => handler?.(msg);

  const backend: AgentBackend = {
    async startSession(): Promise<StartSessionResult> {
      return { sessionId: 'child_session_started' as SessionId };
    },
    async loadSession(_sessionId: SessionId): Promise<StartSessionResult> {
      return { sessionId: 'child_session_loaded' as SessionId };
    },
    async loadSessionWithReplayCapture(_sessionId: SessionId): Promise<StartSessionResult & { replay: unknown[] }> {
      return { sessionId: 'child_session_loaded' as SessionId, replay: [] };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {
      // Default no-op; tests can emit messages via `emit(...)`.
    },
    async cancel(_sessionId: SessionId): Promise<void> {},
    onMessage(nextHandler): void {
      handler = nextHandler as any;
    },
    async dispose(): Promise<void> {},
  };

  return { backend, emit };
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
    const { backend, emit } = createResumableBackendHarness();
    backend.sendPrompt = async (_sessionId, _prompt) => {
      emit({ type: 'tool-call', toolName: 'bash', callId: 'call_123', args: { command: 'ls' } });
    };

    const run = createLongLivedResumableRun();
    const runs = new Map([[run.runId, run]]);
    const controllers = new Map();

    const res = await sendBackendLongLivedRun({
      runId: run.runId,
      params: { message: 'hi', resume: true },
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => createExecutionRunHostRuntimeFromAgentBackend(backend),
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
    const { backend } = createResumableBackendHarness();

    const run = createLongLivedResumableRun({ turnCount: 2 });
    const runs = new Map([[run.runId, run]]);
    const controllers = new Map();

    const res = await sendBackendLongLivedRun({
      runId: run.runId,
      params: { message: 'hi', resume: true },
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => createExecutionRunHostRuntimeFromAgentBackend(backend),
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
