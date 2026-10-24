import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentMessageHandler, SessionId, StartSessionResult } from '@/agent/core/AgentBackend';

import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import { resumeBackendControllerForResumableRun } from '@/agent/executionRuns/runtime/resumeBackendController';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { disposeExecutionRunBackendController } from './settleExecutionRunControllerOccurrence';

describe('resumeBackendControllerForResumableRun', () => {
  it.each(['acquisition', 'load'] as const)('rejects a resume retired during backend %s without restoring its controller', async (phase) => {
    const run: ExecutionRunState = {
      runId: 'run_retired', callId: 'call_retired', sidechainId: 'sidechain_retired', sessionId: 'parent_retired', depth: 0,
      intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, backendId: 'claude',
      instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
      ioMode: 'request_response', status: 'cancelled', startedAtMs: 1, resumeHandle: {
        kind: 'vendor_session.v1', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        vendorSessionId: 'vendor_retired',
      },
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reachedBoundary!: () => void;
    const boundary = new Promise<void>((resolve) => { reachedBoundary = resolve; });
    let closing = false;
    const dispose = vi.fn(async () => undefined);
    const load = vi.fn(async () => {
      if (phase === 'load') { reachedBoundary(); await gate; }
      return { sessionId: 'child_retired', replay: [] };
    });
    const backend: AgentBackend = {
      startSession: async () => ({ sessionId: 'unused' }),
      loadSessionWithReplayCapture: load,
      sendPrompt: async () => {}, cancel: async () => {}, onMessage: () => {}, dispose,
    };
    const controllers = new Map<string, ExecutionRunController>();
    const runs = new Map([[run.runId, run]]);
    const resume = resumeBackendControllerForResumableRun({
      runId: run.runId, run, runs, controllers, budgetRegistry: null,
      createBackend: async () => {
        if (phase === 'acquisition') { reachedBoundary(); await gate; }
        return { backend };
      },
      isSessionClosing: () => closing,
      sendAcp: () => {}, parentProvider: 'claude', streamedTranscriptSession: null,
      writeActivityMarker: async () => {}, getNowMs: () => 1,
      admitRuntimeActivity: async () => {}, rollbackRuntimeActivityAfterFailedAdmission: async () => {},
      terminalRuntimeActivityAfterFailedAdmission: async () => {},
    });
    try {
      await boundary;
      // The late load case also protects cancellation while the Session stays open.
      closing = phase === 'acquisition';
      const controller = controllers.get(run.runId);
      if (phase === 'load') {
        expect(controller?.kind).toBe('backend');
        if (controller?.kind === 'backend') {
          controller.cancelled = true;
          controllers.delete(run.runId);
          runs.set(run.runId, run);
          await disposeExecutionRunBackendController(controller);
          expect(dispose).toHaveBeenCalledOnce();
        }
      }
      release();
      await expect(resume).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
      expect(dispose).toHaveBeenCalledOnce();
      expect(controllers.has(run.runId)).toBe(false);
      expect(runs.get(run.runId)?.status).toBe('cancelled');
      if (phase === 'acquisition') expect(load).not.toHaveBeenCalled();
    } finally {
      release();
      await resume;
      await backend.dispose();
    }
  });

  it('resumes using loadSession when loadSessionWithReplayCapture is unavailable', async () => {
    let disposed = false;
    const backend: AgentBackend = {
      async startSession(): Promise<StartSessionResult> {
        return { sessionId: 'child_session_1' as SessionId };
      },
      async loadSession(_sessionId: SessionId): Promise<StartSessionResult> {
        return { sessionId: 'child_session_2' as SessionId };
      },
      async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {},
      async cancel(_sessionId: SessionId): Promise<void> {},
      onMessage(): void {},
      async dispose(): Promise<void> {
        disposed = true;
      },
    };

    const run: ExecutionRunState = {
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'sidechain_1',
      sessionId: 'parent_session_1',
      depth: 0,
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      backendId: 'claude',
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      status: 'cancelled',
      startedAtMs: 1_700_000_000_000,
      resumeHandle: {
        kind: 'vendor_session.v1',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        vendorSessionId: 'vendor_session_1',
      },
    };

    const controllers = new Map();
    const runs = new Map([[run.runId, run]]);
    const res = await resumeBackendControllerForResumableRun({
      runId: run.runId,
      run,
      runs,
      controllers,
      budgetRegistry: null,
      createBackend: async () => ({ backend }),
      sendAcp: () => undefined,
      parentProvider: 'claude' as any,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      getNowMs: () => 1,
      admitRuntimeActivity: async () => undefined,
      rollbackRuntimeActivityAfterFailedAdmission: async () => undefined,
      terminalRuntimeActivityAfterFailedAdmission: async () => undefined,
    });

    expect(res).toEqual({ ok: true });
    expect(disposed).toBe(false);
    expect(runs.get(run.runId)?.status).toBe('running');
    expect(controllers.has(run.runId)).toBe(true);
  });

  it('terminalizes an admitted occurrence when backend recreation fails', async () => {
    const run = {
      runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1', sessionId: 'parent_1', depth: 0,
      intent: 'delegate' as const, backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' as const },
      backendId: 'claude', instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable' as const,
      runClass: 'long_lived' as const, ioMode: 'request_response' as const, status: 'cancelled' as const,
      startedAtMs: 1, resumeHandle: {
        kind: 'vendor_session.v1' as const,
        backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' as const },
        vendorSessionId: 'vendor_session_1',
      },
    };
    const admitRuntimeActivity = vi.fn(async () => undefined);
    const terminalRuntimeActivityAfterFailedAdmission = vi.fn(async () => undefined);

    const result = await resumeBackendControllerForResumableRun({
      runId: run.runId,
      run,
      runs: new Map([[run.runId, run]]),
      controllers: new Map(),
      budgetRegistry: null,
      createBackend: async () => {
        throw new Error('backend recreation failed');
      },
      sendAcp: () => undefined,
      parentProvider: 'claude',
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      getNowMs: () => 1,
      admitRuntimeActivity,
      rollbackRuntimeActivityAfterFailedAdmission: async () => undefined,
      terminalRuntimeActivityAfterFailedAdmission,
    });

    expect(result).toEqual({ ok: false, errorCode: 'execution_run_failed', error: 'backend recreation failed' });
    expect(admitRuntimeActivity).toHaveBeenCalledWith(run.runId);
    expect(terminalRuntimeActivityAfterFailedAdmission).toHaveBeenCalledWith(run.runId, 'execution_run_resume_failed');
  });

  it('accepts backend events emitted during the serialized resume load before controller installation', async () => {
    let handler: AgentMessageHandler | null = null;
    const sendAcp = vi.fn();
    const backend: AgentBackend = {
      async startSession(): Promise<StartSessionResult> {
        return { sessionId: 'child_session_1' as SessionId };
      },
      async loadSessionWithReplayCapture(): Promise<StartSessionResult & { replay: unknown[] }> {
        handler?.({ type: 'tool-call', toolName: 'read', args: { file: 'during-load' }, callId: 'load-call' });
        return { sessionId: 'child_session_2' as SessionId, replay: [] };
      },
      async sendPrompt(): Promise<void> {},
      async cancel(): Promise<void> {},
      onMessage(next): void {
        handler = next;
      },
      async dispose(): Promise<void> {},
    };
    const run: ExecutionRunState = {
      runId: 'run_load', callId: 'call_load', sidechainId: 'sidechain_load', sessionId: 'parent_1', depth: 0,
      intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, backendId: 'claude',
      instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
      ioMode: 'request_response', status: 'cancelled', startedAtMs: 1, resumeHandle: {
        kind: 'vendor_session.v1', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        vendorSessionId: 'vendor_session_1',
      },
    };

    await expect(resumeBackendControllerForResumableRun({
      runId: run.runId,
      run,
      runs: new Map([[run.runId, run]]),
      controllers: new Map(),
      budgetRegistry: null,
      createBackend: async () => ({ backend }),
      sendAcp,
      parentProvider: 'claude',
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      getNowMs: () => 1,
      admitRuntimeActivity: async () => undefined,
      rollbackRuntimeActivityAfterFailedAdmission: async () => undefined,
      terminalRuntimeActivityAfterFailedAdmission: async () => undefined,
      requireReplayCapture: true,
    })).resolves.toEqual({ ok: true });

    expect(sendAcp).toHaveBeenCalledWith('claude', expect.objectContaining({
      type: 'tool-call',
      name: 'read',
    }), expect.anything());
  });

  it('terminalizes the admitted occurrence when backend message-handler registration fails', async () => {
    const run: ExecutionRunState = {
      runId: 'run_handler_failure', callId: 'call_1', sidechainId: 'sidechain_1', sessionId: 'parent_1', depth: 0,
      intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, backendId: 'claude',
      instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
      ioMode: 'request_response', status: 'cancelled', startedAtMs: 1, resumeHandle: {
        kind: 'vendor_session.v1', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        vendorSessionId: 'vendor_session_1',
      },
    };
    const terminalRuntimeActivityAfterFailedAdmission = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);
    const backend: AgentBackend = {
      async startSession(): Promise<StartSessionResult> {
        return { sessionId: 'unused' as SessionId };
      },
      async loadSessionWithReplayCapture(): Promise<StartSessionResult & { replay: unknown[] }> {
        return { sessionId: 'unused' as SessionId, replay: [] };
      },
      async sendPrompt(): Promise<void> {},
      async cancel(): Promise<void> {},
      onMessage(): void {
        throw new Error('handler registration failed');
      },
      dispose,
    };

    await expect(resumeBackendControllerForResumableRun({
      runId: run.runId,
      run,
      runs: new Map([[run.runId, run]]),
      controllers: new Map(),
      budgetRegistry: null,
      createBackend: async () => ({ backend }),
      sendAcp: () => undefined,
      parentProvider: 'claude',
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      getNowMs: () => 1,
      admitRuntimeActivity: async () => undefined,
      rollbackRuntimeActivityAfterFailedAdmission: async () => undefined,
      terminalRuntimeActivityAfterFailedAdmission,
      requireReplayCapture: true,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_failed',
      error: 'handler registration failed',
    });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(terminalRuntimeActivityAfterFailedAdmission).toHaveBeenCalledWith(
      run.runId,
      'execution_run_resume_failed',
    );
  });
});
