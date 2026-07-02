import { describe, expect, it, vi } from 'vitest';

import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from '../executionRunTypes';
import { createExecutionRunControllerMessageHandler } from './sessionStateEmission';

function createController(): ExecutionRunBackendController {
  let resolveTerminal!: () => void;
  const terminalPromise = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  return {
    kind: 'backend',
    backend: {
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
    },
    backendSupportsResume: true,
    childSessionId: 'child_session_1',
    buffer: '',
    sidechainStreamBuffer: '',
    sidechainStreamKey: '',
    streamWriter: null,
    cancelled: false,
    turnCount: 1,
    turnEpoch: 1,
    turnInFlight: true,
    turnCancelReason: null,
    turnCancelEpoch: null,
    pendingExternalMessages: [],
    pendingExternalMessagesSignal: null,
    lastMarkerWriteAtMs: 0,
    terminalPromise,
    resolveTerminal,
  };
}

function createRunningRun(): ExecutionRunState {
  return {
    runId: 'run_1',
    callId: 'call_1',
    sidechainId: 'sidechain_1',
    sessionId: 'parent_session_1',
    depth: 1,
    intent: 'review',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    backendId: 'codex',
    instructions: 'review',
    permissionMode: 'read_only',
    retentionPolicy: 'resumable',
    runClass: 'bounded',
    ioMode: 'request_response',
    status: 'running',
    startedAtMs: 1,
  };
}

describe('createExecutionRunControllerMessageHandler', () => {
  it('writes activity markers for meaningful runtime activity but not vendor session bookkeeping', async () => {
    const ctrl = createController();
    const runs = new Map([['run_1', createRunningRun()]]);
    const writeActivityMarker = vi.fn(async () => {});
    const handler = createExecutionRunControllerMessageHandler({
      ctrl,
      runId: 'run_1',
      sidechainId: 'sidechain_1',
      ioMode: 'request_response',
      computeSidechainStreamText: () => null,
      sendAcp: () => {},
      parentProvider: 'codex',
      runs,
      backendSupportsResume: true,
      writeActivityMarker,
      getNowMs: () => 123,
    });

    handler({ type: 'event', name: 'provider_session_id', payload: { sessionId: 'vendor_1' } });
    expect(writeActivityMarker).not.toHaveBeenCalled();

    handler({ type: 'tool-call', toolName: 'read', args: { file: 'README.md' }, callId: 'tool_1' });
    handler({ type: 'tool-result', toolName: 'read', result: 'ok', callId: 'tool_1' });
    handler({ type: 'status', status: 'running' });
    handler({ type: 'event', name: 'thinking', payload: { text: 'checking' } });
    handler({ type: 'terminal-output', data: 'running tests' } as never);
    await Promise.resolve();
    expect(writeActivityMarker).toHaveBeenCalledTimes(5);
    expect(writeActivityMarker).toHaveBeenCalledWith('run_1', 123);
  });

  it('accepts legacy vendor_session_id events as provider session identity compatibility', () => {
    const ctrl = createController();
    const runs = new Map([['run_1', createRunningRun()]]);
    const handler = createExecutionRunControllerMessageHandler({
      ctrl,
      runId: 'run_1',
      sidechainId: 'sidechain_1',
      ioMode: 'request_response',
      computeSidechainStreamText: () => null,
      sendAcp: () => {},
      parentProvider: 'codex',
      runs,
      backendSupportsResume: true,
      writeActivityMarker: async () => {},
      getNowMs: () => 123,
    });

    handler({ type: 'event', name: 'vendor_session_id', payload: { sessionId: 'legacy-provider-session' } });

    expect(ctrl.childSessionId).toBe('legacy-provider-session');
    expect(runs.get('run_1')?.resumeHandle).toMatchObject({
      kind: 'provider_session.v1',
      providerSessionId: 'legacy-provider-session',
    });
  });
});
