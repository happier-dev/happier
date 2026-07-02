import { describe, expect, it } from 'vitest';

import type { AgentBackend, SessionId, StartSessionResult } from '@/agent/core/AgentBackend';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { createExecutionRunHostRuntimeFromAgentBackend } from '@/agent/runtime/bridges/executionRun/testkit';
import { resumeBackendControllerForResumableRun } from '@/agent/runtime/bridges/executionRun/resumeBackendController';

describe('resumeBackendControllerForResumableRun', () => {
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
    };

    const controllers = new Map();
    const runs = new Map([[run.runId, run]]);
    const res = await resumeBackendControllerForResumableRun({
      runId: run.runId,
      run,
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: (_opts) => createExecutionRunHostRuntimeFromAgentBackend(backend),
      sendAcp: () => undefined,
      parentProvider: 'acme.runtime.provider' as any,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      getNowMs: () => 1,
    });

    expect(res).toEqual({ ok: true });
    expect(disposed).toBe(false);
    expect(runs.get(run.runId)?.status).toBe('running');
    expect(controllers.has(run.runId)).toBe(true);
  });
});
