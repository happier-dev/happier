import { describe, expect, it, vi } from 'vitest';

import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { FinishExecutionRun } from '@/agent/runtime/bridges/executionRun/executionRunFinishRun';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import {
  createTestExecutionRunHostRuntime,
  type TestExecutionRunHostRuntime,
  type TestExecutionRunHostRuntimeOptions,
} from '@/agent/runtime/bridges/executionRun/testkit';

import { executeBoundedBackendRun } from '@/agent/runtime/bridges/executionRun/bounded/loop';

const mockedLogger = vi.hoisted(() => ({
  debug: vi.fn(),
}));

vi.mock('@/lib', () => ({
  logger: mockedLogger,
}));

vi.mock('@/ui/logger', async (importOriginal) => {
  const original = await importOriginal<any>();
  return { ...original, logger: mockedLogger };
});

const TEST_PRIMARY_BACKEND_ID = `${'primary'}.${'backend'}` as never;
const TEST_RECOVERY_BACKEND_ID = `${'recovery'}.${'backend'}` as never;

type PromptRuntimeHandler = (
  runtime: TestExecutionRunHostRuntime,
  sessionId: string,
  prompt: string,
) => void | Promise<void>;

function createPromptRuntime(
  onSendPrompt: PromptRuntimeHandler,
  opts: Omit<TestExecutionRunHostRuntimeOptions, 'onSendPrompt'> = {},
): TestExecutionRunHostRuntime {
  let runtime: TestExecutionRunHostRuntime;
  runtime = createTestExecutionRunHostRuntime({
    ...opts,
    onSendPrompt: async (sessionId, prompt) => {
      await onSendPrompt(runtime, sessionId, prompt);
    },
  });
  return runtime;
}

function createRuntimeWithStuckFirstCompletion(): Readonly<{
  runtime: ExecutionRunHostRuntime;
  getSendPromptCount: () => number;
}> {
  let sendPromptCount = 0;
  let donePromise: Promise<void> = Promise.resolve();

  const runtime = createPromptRuntime(
    async () => {
      sendPromptCount += 1;
      if (sendPromptCount === 1) {
        donePromise = new Promise<void>(() => {});
        return;
      }
      donePromise = new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    },
    {
      onCancel: async () => {},
      onWaitForTurnCompletion: async () => {
        await donePromise;
      },
    },
  );

  return { runtime, getSendPromptCount: () => sendPromptCount };
}

function createRuntimeWithSlowCancel(args: Readonly<{ cancelDelayMs: number }>): Readonly<{
  runtime: ExecutionRunHostRuntime;
  getSendPromptCount: () => number;
}> {
  let sendPromptCount = 0;
  let donePromise: Promise<void> = Promise.resolve();

  const runtime = createPromptRuntime(
    async () => {
      sendPromptCount += 1;
      if (sendPromptCount === 1) {
        donePromise = new Promise<void>(() => {});
        return;
      }
      donePromise = new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    },
    {
      onCancel: async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, args.cancelDelayMs);
        });
      },
      onWaitForTurnCompletion: async () => {
        await donePromise;
      },
    },
  );

  return { runtime, getSendPromptCount: () => sendPromptCount };
}

function createRuntimeWithBlockingSendPromptNoWaiter(): Readonly<{
  runtime: ExecutionRunHostRuntime;
  getSendPromptCount: () => number;
}> {
  let sendPromptCount = 0;
  let unblockFirstPrompt: (() => void) | null = null;

  const runtime = createPromptRuntime(
    async () => {
      sendPromptCount += 1;
      if (sendPromptCount === 1) {
        await new Promise<void>((resolve) => {
          unblockFirstPrompt = resolve;
        });
        return;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    },
    {
      onCancel: async () => {
        unblockFirstPrompt?.();
        unblockFirstPrompt = null;
      },
    },
  );

  return { runtime, getSendPromptCount: () => sendPromptCount };
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

    const { runtime, getSendPromptCount } = createRuntimeWithStuckFirstCompletion();

    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });

    const ctrl: ExecutionRunBackendController = {
      kind: 'backend',
      backend: runtime,
      backendSupportsResume: false,
      childSessionId: 'child_session_1',
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
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        instructions: 'start',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      controllers,
      sendAcp: () => {},
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      getNowMs: () => 1,
      boundedTimeoutMs: null,
      finishRun: () => {},
    });

    await withTimeout(externalAck, 250);
    expect(getSendPromptCount()).toBe(2);
    await withTimeout(runPromise, 1_000);
  });

  it('acks external cancel+send promptly even when cancel is slow', async () => {
    mockedLogger.debug.mockClear();
    const runId = 'run_test_slow_cancel_1';
    const callId = 'subagent_run_test_slow_cancel_1';
    const sidechainId = callId;

    const { runtime, getSendPromptCount } = createRuntimeWithSlowCancel({ cancelDelayMs: 200 });

    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });

    const ctrl: ExecutionRunBackendController = {
      kind: 'backend',
      backend: runtime,
      backendSupportsResume: false,
      childSessionId: 'child_session_1',
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
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        instructions: 'start',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      controllers,
      sendAcp: () => {},
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      getNowMs: () => 1,
      boundedTimeoutMs: null,
      finishRun: (() => {}) as FinishExecutionRun,
    });

    await withTimeout(externalAck, 100);
    await withTimeout(runPromise, 2_000);
    expect(getSendPromptCount()).toBe(2);
  });

  it('processes external cancel+send while sendPrompt is still in-flight (without waitForResponseComplete)', async () => {
    mockedLogger.debug.mockClear();
    const runId = 'run_test_blocking_send_1';
    const callId = 'subagent_run_test_blocking_send_1';
    const sidechainId = callId;

    const { runtime, getSendPromptCount } = createRuntimeWithBlockingSendPromptNoWaiter();

    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });

    const ctrl: ExecutionRunBackendController = {
      kind: 'backend',
      backend: runtime,
      backendSupportsResume: false,
      childSessionId: 'child_session_1',
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
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        instructions: 'start',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      controllers,
      sendAcp: () => {},
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      getNowMs: () => 1,
      boundedTimeoutMs: null,
      finishRun: (() => {}) as FinishExecutionRun,
    });

    await withTimeout(externalAck, 250);
    await withTimeout(runPromise, 2_000);
    expect(getSendPromptCount()).toBe(2);
  });

  it('acks external cancel+send before a slow replacement sendPrompt resolves', async () => {
    mockedLogger.debug.mockClear();
    const runId = 'run_test_slow_replacement_send_1';
    const callId = 'subagent_run_test_slow_replacement_send_1';
    const sidechainId = callId;
    const childSessionId = 'child_session_slow_replacement_send_1';

    let sendPromptCount = 0;
    let unblockFirstPrompt: (() => void) | null = null;
    let donePromise: Promise<void> = Promise.resolve();

    const runtime = createPromptRuntime(
      async () => {
        sendPromptCount += 1;
        if (sendPromptCount === 1) {
          await new Promise<void>((resolve) => {
            unblockFirstPrompt = resolve;
          });
          return;
        }
        donePromise = new Promise<void>((resolve) => {
          setTimeout(resolve, 200);
        });
        await donePromise;
      },
      {
        sessionId: childSessionId,
        onCancel: async () => {
          unblockFirstPrompt?.();
          unblockFirstPrompt = null;
        },
        onWaitForTurnCompletion: async () => {
          await donePromise;
        },
      },
    );

    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });

    const ctrl: ExecutionRunBackendController = {
      kind: 'backend',
      backend: runtime,
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
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        instructions: 'start',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      controllers,
      sendAcp: () => {},
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      getNowMs: () => 1,
      boundedTimeoutMs: null,
      finishRun: (() => {}) as FinishExecutionRun,
    });

    await withTimeout(externalAck, 50);
    expect(sendPromptCount).toBe(2);
    await withTimeout(runPromise, 1_000);
  });

  it('logs unexpected canceled turn completion errors (without surfacing them as unhandled rejections)', async () => {
    mockedLogger.debug.mockClear();

    const childSessionId = 'child_session_1';
    let sendPromptCount = 0;
    const turnCompletions: Array<Promise<Error | null>> = [];

    const runtime = createPromptRuntime(
      () => {
        sendPromptCount += 1;
        if (sendPromptCount === 1) {
          turnCompletions.push(new Promise((resolve) => {
            setTimeout(() => {
              resolve(new Error('unexpected failure'));
            }, 25);
          }));
          return;
        }
        turnCompletions.push(new Promise((resolve) => {
          setTimeout(() => resolve(null), 10);
        }));
      },
      {
        onCancel: async () => {},
        onWaitForTurnCompletion: async () => {
          const completion = turnCompletions.shift() ?? Promise.resolve(null);
          const error = await completion;
          if (error) throw error;
        },
      },
    );

    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });

    const ctrl: ExecutionRunBackendController = {
      kind: 'backend',
      backend: runtime,
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
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        instructions: 'start',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      controllers,
      sendAcp: () => {},
      parentProvider: TEST_PRIMARY_BACKEND_ID,
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

  it('repairs invalid delegate output with a single JSON-only retry', async () => {
    const runId = 'run_delegate_repair_1';
    const callId = 'subagent_run_delegate_repair_1';
    const sidechainId = callId;
    const childSessionId = 'child_session_delegate_repair';

    const prompts: string[] = [];
    let sendPromptCount = 0;

    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });

    let ctrl!: ExecutionRunBackendController;
    const runtime = createPromptRuntime(
      (_runtime, _sessionId, prompt) => {
        prompts.push(prompt);
        sendPromptCount += 1;
        if (sendPromptCount === 1) {
          ctrl.buffer = 'I created the file pi-run-test.txt and printed its first line.';
          return;
        }
        ctrl.buffer = [
          '{',
          '  \"summary\": \"Ok\",',
          '  \"deliverables\": [{ \"id\": \"d1\", \"title\": \"pi-run-test.txt\" }]',
          '}',
        ].join('\n');
      },
      { sessionId: childSessionId, onWaitForTurnCompletion: async () => {} },
    );

    ctrl = {
      kind: 'backend',
      backend: runtime,
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

    const controllers = new Map([[runId, ctrl]]);
    const finishRun = vi.fn<FinishExecutionRun>();

    await executeBoundedBackendRun({
      runId,
      callId,
      sidechainId,
      startedAtMs: 0,
      params: {
        sessionId: 'parent_session_delegate_repair',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
        instructions: 'do the thing',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      controllers,
      sendAcp: () => {},
      parentProvider: 'pi',
      getNowMs: () => 1,
      boundedTimeoutMs: null,
      finishRun,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Return ONLY valid JSON');
    expect(finishRun).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ status: 'succeeded' }),
      expect.objectContaining({
        output: expect.objectContaining({ status: 'succeeded' }),
      }),
      expect.objectContaining({ kind: 'delegate_output.v1' }),
    );
  });

  it('uses a repair prompt whose JSON example can be copied verbatim (delegate)', async () => {
    const runId = 'run_delegate_repair_copycat_1';
    const callId = 'subagent_run_delegate_repair_copycat_1';
    const sidechainId = callId;
    const childSessionId = 'child_session_delegate_repair_copycat';

    const prompts: string[] = [];
    let sendPromptCount = 0;

    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });

    const extractFirstJsonObject = (prompt: string): string => {
      const start = prompt.indexOf('{');
      if (start < 0) return '';
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < prompt.length; i += 1) {
        const ch = prompt[i]!;
        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (ch === '\\\\') {
            escaped = true;
            continue;
          }
          if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === '{') {
          depth += 1;
          continue;
        }
        if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            return prompt.slice(start, i + 1);
          }
        }
      }
      return '';
    };

    let ctrl!: ExecutionRunBackendController;
    const runtime = createPromptRuntime(
      (_runtime, _sessionId, prompt) => {
        prompts.push(prompt);
        sendPromptCount += 1;
        if (sendPromptCount === 1) {
          ctrl.buffer = 'Here are the deliverables in prose, but not JSON.';
          return;
        }
        ctrl.buffer = extractFirstJsonObject(prompt);
      },
      { sessionId: childSessionId, onWaitForTurnCompletion: async () => {} },
    );

    ctrl = {
      kind: 'backend',
      backend: runtime,
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

    const controllers = new Map([[runId, ctrl]]);
    const finishRun = vi.fn<FinishExecutionRun>();

    await executeBoundedBackendRun({
      runId,
      callId,
      sidechainId,
      startedAtMs: 0,
      params: {
        sessionId: 'parent_session_delegate_repair_copycat',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
        instructions: 'delegate it',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      controllers,
      sendAcp: () => {},
      parentProvider: 'pi',
      getNowMs: () => 1,
      boundedTimeoutMs: null,
      finishRun,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Return ONLY valid JSON');
    expect(finishRun).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ status: 'succeeded' }),
      expect.objectContaining({
        output: expect.objectContaining({ status: 'succeeded' }),
      }),
      expect.objectContaining({ kind: 'delegate_output.v1' }),
    );
  });

  it('uses a repair prompt that includes the full review finding contract', async () => {
    const runId = 'run_review_repair_schema_1';
    const callId = 'subagent_run_review_repair_schema_1';
    const sidechainId = callId;
    const childSessionId = 'child_session_review_repair_schema';

    const prompts: string[] = [];
    let sendPromptCount = 0;

    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });

    let ctrl!: ExecutionRunBackendController;
    const runtime = createPromptRuntime(
      (_runtime, _sessionId, prompt) => {
        prompts.push(prompt);
        sendPromptCount += 1;
        if (sendPromptCount === 1) {
          ctrl.buffer = 'Here are findings in prose, but not valid JSON.';
          return;
        }

        const hasFullFindingContract =
          prompt.includes('"id": string')
          && prompt.includes('"title": string')
          && prompt.includes('"severity": "blocker"|"high"|"medium"|"low"|"nit"')
          && prompt.includes('"category": "correctness"|"security"|"performance"|"maintainability"|"testing"|"style"|"docs"');

        ctrl.buffer = hasFullFindingContract
          ? [
              '{',
              '  "summary": "Ok",',
              '  "findings": [',
              '    {',
              '      "id": "f1",',
              '      "title": "Prompt is ignored",',
              '      "severity": "medium",',
              '      "category": "correctness",',
              '      "summary": "The backend ignores the prompt parameter.",',
              '      "filePath": "apps/cli/src/agent/reviews/prompt/buildStandardReviewPrompt.ts",',
              '      "startLine": 137,',
              '      "endLine": 137',
              '    }',
              '  ]',
              '}',
            ].join('\n')
          : [
              '{',
              '  "summary": "Ok",',
              '  "findings": [',
              '    {',
              '      "severity": "medium",',
              '      "category": "correctness",',
              '      "summary": "Missing id/title because the repair prompt did not specify them."',
              '    }',
              '  ]',
              '}',
            ].join('\n');
      },
      { sessionId: childSessionId, onWaitForTurnCompletion: async () => {} },
    );

    ctrl = {
      kind: 'backend',
      backend: runtime,
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

    const controllers = new Map([[runId, ctrl]]);
    const finishRun = vi.fn<FinishExecutionRun>();

    await executeBoundedBackendRun({
      runId,
      callId,
      sidechainId,
      startedAtMs: 0,
      params: {
        sessionId: 'parent_session_review_repair_schema',
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_RECOVERY_BACKEND_ID },
        instructions: 'review it',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      controllers,
      sendAcp: () => {},
      parentProvider: TEST_RECOVERY_BACKEND_ID,
      getNowMs: () => 1,
      boundedTimeoutMs: null,
      finishRun,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('return ONLY valid JSON');
    expect(prompts[1]).not.toContain('Do not run any tools.');
    expect(prompts[1]).toContain('If you have not yet inspected the workspace or gathered enough evidence');
    expect(finishRun).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ status: 'succeeded' }),
      expect.objectContaining({
        output: expect.objectContaining({ status: 'succeeded' }),
      }),
      expect.objectContaining({ kind: 'review_findings.v2' }),
    );
  });

  it('does not pass the bounded timeout through to backend waitForResponseComplete', async () => {
    const runId = 'run_wait_timeout_1';
    const callId = 'subagent_run_wait_timeout_1';
    const sidechainId = callId;
    const childSessionId = 'child_session_wait_timeout';
    const waitTimeouts: Array<number | null | undefined> = [];

    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });

    let ctrl!: ExecutionRunBackendController;
    const runtime = createPromptRuntime(
      () => {
        ctrl.buffer = JSON.stringify({ findings: [], summary: 'ok' });
      },
      {
        sessionId: childSessionId,
        onWaitForTurnCompletion: async (timeoutMs) => {
          waitTimeouts.push(timeoutMs);
        },
      },
    );

    ctrl = {
      kind: 'backend',
      backend: runtime,
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

    const finishRun = vi.fn<FinishExecutionRun>();

    await executeBoundedBackendRun({
      runId,
      callId,
      sidechainId,
      startedAtMs: 0,
      params: {
        sessionId: 'parent_session_wait_timeout',
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        instructions: 'review it',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      controllers: new Map([[runId, ctrl]]),
      sendAcp: () => {},
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      getNowMs: () => 1,
      boundedTimeoutMs: 600_000,
      finishRun,
    });

    expect(waitTimeouts).toEqual([undefined]);
    expect(finishRun).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ status: 'succeeded' }),
      expect.objectContaining({
        output: expect.objectContaining({ status: 'succeeded' }),
      }),
      expect.objectContaining({ kind: 'review_findings.v2' }),
    );
  });

  it('keeps waiting past the bounded interval when backend liveness cannot be probed', async () => {
    const runId = 'run_liveness_probe_failed_continues_1';
    const callId = 'subagent_run_liveness_probe_failed_continues_1';
    const sidechainId = callId;
    const childSessionId = 'child_session_liveness_probe_failed';

    let resolveTurn!: () => void;
    const turnDone = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });

    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });

    let ctrl!: ExecutionRunBackendController;
    const cancel = vi.fn(async () => {});
    const runtime: ExecutionRunHostRuntime = Object.freeze({
      async readResumeSupport() {
        return false;
      },
      async provisionSession() {
        return { sessionId: childSessionId };
      },
      async sendPrompt(): Promise<void> {
        ctrl.buffer = JSON.stringify({ findings: [], summary: 'ok' });
        setTimeout(resolveTurn, 25);
      },
      cancel,
      async dispose(): Promise<void> {},
      async waitForTurnCompletion(): Promise<void> {
        await turnDone;
      },
      subscribeMessages() {
        return () => undefined;
      },
    });

    ctrl = {
      kind: 'backend',
      backend: runtime,
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

    const finishRun = vi.fn<FinishExecutionRun>();

    await executeBoundedBackendRun({
      runId,
      callId,
      sidechainId,
      startedAtMs: 0,
      params: {
        sessionId: 'parent_session_liveness_probe_failed',
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_PRIMARY_BACKEND_ID },
        instructions: 'review it',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      controllers: new Map([[runId, ctrl]]),
      sendAcp: () => {},
      parentProvider: TEST_PRIMARY_BACKEND_ID,
      getNowMs: () => 1,
      boundedTimeoutMs: 10,
      finishRun,
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(finishRun).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ status: 'succeeded' }),
      expect.objectContaining({
        output: expect.objectContaining({ status: 'succeeded' }),
      }),
      expect.objectContaining({ kind: 'review_findings.v2' }),
    );
  });

  it('repairs invalid plan output with a single JSON-only retry', async () => {
    const runId = 'run_plan_repair_1';
    const callId = 'subagent_run_plan_repair_1';
    const sidechainId = callId;
    const childSessionId = 'child_session_plan_repair';

    const prompts: string[] = [];
    let sendPromptCount = 0;

    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });

    let ctrl!: ExecutionRunBackendController;
    const runtime = createPromptRuntime(
      (_runtime, _sessionId, prompt) => {
        prompts.push(prompt);
        sendPromptCount += 1;
        if (sendPromptCount === 1) {
          ctrl.buffer = 'Here is the plan in prose, but not JSON.';
          return;
        }
        ctrl.buffer = [
          '{',
          '  \"summary\": \"Ok\",',
          '  \"sections\": [{ \"title\": \"Step 1\", \"items\": [\"Do it\"] }]',
          '}',
        ].join('\n');
      },
      { sessionId: childSessionId, onWaitForTurnCompletion: async () => {} },
    );

    ctrl = {
      kind: 'backend',
      backend: runtime,
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

    const controllers = new Map([[runId, ctrl]]);
    const finishRun = vi.fn<FinishExecutionRun>();

    await executeBoundedBackendRun({
      runId,
      callId,
      sidechainId,
      startedAtMs: 0,
      params: {
        sessionId: 'parent_session_plan_repair',
        intent: 'plan',
        backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
        instructions: 'plan it',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      controllers,
      sendAcp: () => {},
      parentProvider: 'pi',
      getNowMs: () => 1,
      boundedTimeoutMs: null,
      finishRun,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Return ONLY valid JSON');
    expect(finishRun).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ status: 'succeeded' }),
      expect.objectContaining({
        output: expect.objectContaining({ status: 'succeeded' }),
      }),
      expect.objectContaining({ kind: 'plan_output.v1' }),
    );
  });
});
