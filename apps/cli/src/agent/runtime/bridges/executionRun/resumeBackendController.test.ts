import { describe, expect, it } from 'vitest';

import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { resumeBackendControllerForResumableRun } from '@/agent/runtime/bridges/executionRun/resumeBackendController';
import { createTestExecutionRunHostRuntime } from './testkit/runtime';
import { startExecutionRun } from './startExecutionRun';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';

describe('resumeBackendControllerForResumableRun', () => {
  it('persists a cloned runtime account settings snapshot when starting a run', async () => {
    const runtime = createTestExecutionRunHostRuntime().runtime;
    const accountSettings: Record<string, unknown> = {
      customExecutionRunRuntimeSettings: {
        mode: 'start-time',
      },
    };
    const runs = new Map<string, ExecutionRunState>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by this test');
      },
    });

    try {
      const started = await startExecutionRun({
        params: {
          sessionId: 'parent_session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          accountSettings,
          instructions: '',
          permissionMode: 'read_only',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'request_response',
        },
        parentProvider: 'codex',
        sendAcp: async () => undefined,
        streamedTranscriptSession: null,
        createRuntime: () => runtime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers: new Map(),
        enqueueMarkerWrite: async () => undefined,
        writeActivityMarker: async () => undefined,
        finishRun: async () => undefined,
        executeBoundedRun: async () => undefined,
        send: async () => ({ ok: true }),
        voiceAgentManager,
        getDepthByCallId: () => null,
      });

      (accountSettings.customExecutionRunRuntimeSettings as Record<string, unknown>).mode = 'current-settings';

      expect(runs.get(started.runId)?.runtimeSettings?.accountSettings).toEqual({
        customExecutionRunRuntimeSettings: {
          mode: 'start-time',
        },
      });
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('resumes using loadSession when loadSessionWithReplayCapture is unavailable', async () => {
    let disposed = false;
    const runtime = createTestExecutionRunHostRuntime({
      async provisionSession(opts) {
        return { sessionId: opts?.resumeSessionId ? 'child_session_2' : 'child_session_1' };
      },
      async dispose() {
        disposed = true;
      },
    }).runtime;

    const run: ExecutionRunState = {
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'sidechain_1',
      sessionId: 'parent_session_1',
      depth: 0,
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      backendId: 'codex',
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      status: 'cancelled',
      startedAtMs: 1_700_000_000_000,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
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
      createRuntime: (_opts) => runtime,
      sendAcp: async () => undefined,
      parentProvider: 'codex',
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      getNowMs: () => 1,
    });

    expect(res).toEqual({ ok: true });
    expect(disposed).toBe(false);
    expect(runs.get(run.runId)?.status).toBe('running');
    expect(controllers.has(run.runId)).toBe(true);
  });

  it('passes persisted runtime account settings to the recreated backend runtime', async () => {
    const runtime = createTestExecutionRunHostRuntime({
      provisionSession: async (opts) => ({ sessionId: opts?.resumeSessionId ? 'child_session_2' : 'child_session_1' }),
    }).runtime;
    const runtimeOptions: Array<Readonly<Record<string, unknown>>> = [];

    const run: ExecutionRunState & {
      runtimeSettings: {
        accountSettings: Readonly<Record<string, unknown>>;
      };
    } = {
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'sidechain_1',
      sessionId: 'parent_session_1',
      depth: 0,
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      backendId: 'codex',
      instructions: '',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      status: 'cancelled',
      startedAtMs: 1_700_000_000_000,
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        providerSessionId: 'vendor_session_1',
      },
      runtimeSettings: {
        accountSettings: {
          customExecutionRunRuntimeSettings: {
            mode: 'start-time',
          },
        },
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
      createRuntime: (opts) => {
        runtimeOptions.push({ ...opts });
        return runtime;
      },
      sendAcp: async () => undefined,
      parentProvider: 'codex',
      streamedTranscriptSession: null,
      writeActivityMarker: async () => undefined,
      getNowMs: () => 1,
    });

    expect(res).toEqual({ ok: true });
    expect(runtimeOptions[0]?.accountSettings).toEqual({
      customExecutionRunRuntimeSettings: {
        mode: 'start-time',
      },
    });
  });
});
