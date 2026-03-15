import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, SessionId } from '@/agent/core/AgentBackend';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';

import { executeBoundedBackendRun } from './boundedBackendRun';

const mockedLogger = vi.hoisted(() => ({
  debug: vi.fn(),
}));

vi.mock('@/lib', () => ({
  logger: mockedLogger,
}));

function createBackendWithStuckFirstCompletion(): Readonly<{
  backend: AgentBackend;
  getSendPromptCount: () => number;
}> {
  const childSessionId: SessionId = 'child_session_1' as SessionId;
  let sendPromptCount = 0;
  let donePromise: Promise<void> = Promise.resolve();

  const backend: AgentBackend = {
    async startSession(): Promise<{ sessionId: SessionId }> {
      return { sessionId: childSessionId };
    },
    async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {
      sendPromptCount += 1;
      if (sendPromptCount === 1) {
        donePromise = new Promise<void>(() => {});
        return;
      }
      donePromise = new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    },
    async cancel(_sessionId: SessionId): Promise<void> {},
    onMessage(): void {},
    async dispose(): Promise<void> {},
    async waitForResponseComplete(): Promise<void> {
      await donePromise;
    },
  };

  return { backend, getSendPromptCount: () => sendPromptCount };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

describe('executeBoundedBackendRun', () => {
  it('acks external cancel+send even if the canceled turn never completes', async () => {
    mockedLogger.debug.mockClear();
    const runId = 'run_test_1';
    const callId = 'subagent_run_test_1';
    const sidechainId = 'subagent_run_test_1';

    const { backend, getSendPromptCount } = createBackendWithStuckFirstCompletion();

    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });

    const ctrl: ExecutionRunBackendController = {
      kind: 'backend',
      backend,
      childSessionId: 'child_session_1' as SessionId,
      buffer: '',
      sidechainStreamBuffer: '',
      sidechainStreamKey: '',
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

    const controllers = new Map([[runId, ctrl]]);

    let externalAckResolve!: () => void;
    let externalAckReject!: (e: Error) => void;
    const externalAck = new Promise<void>((resolve, reject) => {
      externalAckResolve = resolve;
      externalAckReject = reject;
    });

    ctrl.pendingExternalMessages.push({
      message: 'external message',
      delivery: 'interrupt',
      resolve: externalAckResolve,
      reject: externalAckReject,
    });

    const runPromise = executeBoundedBackendRun({
      runId,
      callId,
      sidechainId,
      startedAtMs: 0,
      params: {
        sessionId: 'parent_session_1',
        intent: 'memory_hints',
        backendId: 'claude',
        instructions: 'start',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      controllers,
      sendAcp: () => {},
      parentProvider: 'claude',
      getNowMs: () => 1,
      boundedTimeoutMs: null,
      finishRun: () => {},
    });

    await withTimeout(externalAck, 250);
    expect(getSendPromptCount()).toBe(2);
    await withTimeout(runPromise, 1_000);
  });

  it('logs unexpected canceled turn completion errors (without surfacing them as unhandled rejections)', async () => {
    mockedLogger.debug.mockClear();

    const childSessionId: SessionId = 'child_session_1' as SessionId;
    let sendPromptCount = 0;
    let donePromise: Promise<void> = Promise.resolve();

    const backend: AgentBackend = {
      async startSession(): Promise<{ sessionId: SessionId }> {
        return { sessionId: childSessionId };
      },
      async sendPrompt(_sessionId: SessionId, _prompt: string): Promise<void> {
        sendPromptCount += 1;
        if (sendPromptCount === 1) {
          donePromise = new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error('unexpected failure')), 25);
          });
          return;
        }
        donePromise = new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      },
      async cancel(_sessionId: SessionId): Promise<void> {},
      onMessage(): void {},
      async dispose(): Promise<void> {},
      async waitForResponseComplete(): Promise<void> {
        await donePromise;
      },
    };

    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });

    const ctrl: ExecutionRunBackendController = {
      kind: 'backend',
      backend,
      childSessionId,
      buffer: '',
      sidechainStreamBuffer: '',
      sidechainStreamKey: '',
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

    const controllers = new Map([['run_test_2', ctrl]]);

    let externalAckResolve!: () => void;
    let externalAckReject!: (e: Error) => void;
    const externalAck = new Promise<void>((resolve, reject) => {
      externalAckResolve = resolve;
      externalAckReject = reject;
    });

    ctrl.pendingExternalMessages.push({
      message: 'external message',
      delivery: 'interrupt',
      resolve: externalAckResolve,
      reject: externalAckReject,
    });

    const runPromise = executeBoundedBackendRun({
      runId: 'run_test_2',
      callId: 'subagent_run_test_2',
      sidechainId: 'subagent_run_test_2',
      startedAtMs: 0,
      params: {
        sessionId: 'parent_session_1',
        intent: 'memory_hints',
        backendId: 'claude',
        instructions: 'start',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      controllers,
      sendAcp: () => {},
      parentProvider: 'claude',
      getNowMs: () => 1,
      boundedTimeoutMs: null,
      finishRun: () => {},
    });

    await withTimeout(externalAck, 250);
    await withTimeout(runPromise, 1_000);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(mockedLogger.debug).toHaveBeenCalledWith(
      '[ExecutionRuns] canceled turn completion rejected (ignored)',
      expect.any(Error),
    );
  });
});
