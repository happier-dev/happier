import { describe, expect, it, vi } from 'vitest';

import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import { failureSignal } from '@/agent/executionRuns/controllers/failureSignal';
import type { ExecutionRunState } from '../executionRunTypes';
import { createExecutionRunControllerMessageHandler } from './sessionStateEmission';

function readPermissionDiagnostic(error: Error | null): unknown {
  return (error as (Error & { executionRunPermissionDiagnostic?: unknown }) | null)
    ?.executionRunPermissionDiagnostic;
}

function createController(opts: Readonly<{
  backend?: Partial<ExecutionRunBackendController['backend']>;
  withFailureSignal?: boolean;
}> = {}): ExecutionRunBackendController {
  let resolveTerminal!: () => void;
  const terminalPromise = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const signal = opts.withFailureSignal ? failureSignal() : null;
  void signal?.promise.catch(() => {});
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
      ...opts.backend,
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
    ...(signal ? { failureSignal: signal } : {}),
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

  it('terminalizes static permission requests with a typed diagnostic instead of recording delivery', () => {
    const cancel = vi.fn(async () => {});
    const ctrl = createController({
      backend: { cancel },
      withFailureSignal: true,
    });
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

    expect(() => handler({
      type: 'permission-request',
      id: 'provider-request-static',
      reason: 'write',
      payload: { toolName: 'write' },
    })).toThrow('Execution-run permission request cannot be surfaced or denied');

    expect(cancel).toHaveBeenCalledWith('child_session_1');
    expect(ctrl.pendingHostBarrier).toBeUndefined();
    expect(readPermissionDiagnostic(ctrl.failureSignal?.readError() ?? null)).toEqual({
      runId: 'run_1',
      reason: 'static',
      capability: 'static',
    });
  });

  it('terminalizes inline permission requests that reach the out-of-band host path', () => {
    const ctrl = createController({ withFailureSignal: true });
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

    handler({
      type: 'event',
      name: 'runtime.capabilities',
      payload: { permissions: { capability: 'inline' } },
    });

    expect(() => handler({
      type: 'permission-request',
      id: 'provider-request-inline',
      reason: 'write',
      payload: { toolName: 'write' },
    })).toThrow('Execution-run permission request cannot be surfaced or denied');

    expect(ctrl.pendingHostBarrier).toBeUndefined();
    expect(readPermissionDiagnostic(ctrl.failureSignal?.readError() ?? null)).toEqual({
      runId: 'run_1',
      reason: 'inline_no_pending_request',
      capability: 'inline',
    });
  });

  it('terminalizes permission responses that resolve as not delivered', async () => {
    const respondToPermission = vi.fn(async () => ({
      delivered: false as const,
      reason: 'unknown_request' as const,
    }));
    const ctrl = createController({
      backend: { respondToPermission },
      withFailureSignal: true,
    });
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

    handler({
      type: 'event',
      name: 'runtime.capabilities',
      payload: { permissions: { capability: 'responds' } },
    });
    handler({
      type: 'permission-request',
      id: 'provider-request-missing',
      reason: 'write',
      payload: { toolName: 'write' },
    });

    await expect(ctrl.pendingHostBarrier).resolves.toBeUndefined();

    expect(respondToPermission).toHaveBeenCalledWith('provider-request-missing', false);
    expect(readPermissionDiagnostic(ctrl.failureSignal?.readError() ?? null)).toEqual({
      runId: 'run_1',
      reason: 'unknown_request',
      capability: 'responds',
    });
  });
});
