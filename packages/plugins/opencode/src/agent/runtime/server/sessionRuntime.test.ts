import { describe, expect, it, vi } from 'vitest';

import type { RuntimeEventV1 } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import { createOpenCodePublicSessionRuntime } from './sessionRuntime.js';

function createOperationsFixture(): OpenCodeRuntimeTurnOperations & Readonly<{
  publish(event: RuntimeEventV1): void;
}> {
  const subscribers = new Set<(event: RuntimeEventV1) => void>();
  let nextTurnId = 0;
  return {
    beginTurnLifecycle: vi.fn(() => {
      nextTurnId += 1;
      for (const subscriber of Array.from(subscribers)) {
        subscriber({
          kind: 'turn-start',
          sessionId: 'happy-session-1',
          turnId: `turn-${nextTurnId}`,
          emittedAtMs: Date.now(),
        });
      }
    }),
    startOrLoadSession: vi.fn(async () => 'provider-session-1'),
    sendTurnPrompt: vi.fn(async () => undefined),
    steerInFlightTurn: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn((handler) => {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    }),
    cancelTurn: vi.fn(async () => undefined),
    listSkills: vi.fn(async () => []),
    readSessionIdentity: vi.fn(() => ({ sessionId: 'provider-session-1' })),
    isHappierAuthoredProviderUserMessageId: vi.fn(() => false),
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
    handleProviderEvent: vi.fn(async () => undefined),
    resetOrDisposeRuntime: vi.fn(async () => undefined),
    publish(event) {
      for (const subscriber of Array.from(subscribers)) subscriber(event);
    },
  };
}

describe('createOpenCodePublicSessionRuntime', () => {
  it('confirms provider acceptance only after OpenCode emits turn evidence', async () => {
    const operations = createOperationsFixture();
    const runtime = createOpenCodePublicSessionRuntime(operations);
    const accepted: Array<Readonly<{ userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });

    await expect(runtime.send({ v: 1, text: 'hello' }, { modelId: 'gpt-5.4-mini', userMessageSeq: 42 })).resolves.toMatchObject({
      status: 'accepted',
    });

    expect(operations.sendTurnPrompt).toHaveBeenCalledWith('hello', {
      modelId: 'gpt-5.4-mini',
      userMessageSeq: 42,
      userMessageSeqs: [42],
    });
    expect(accepted).toEqual([]);

    operations.publish({
      kind: 'transcript-agent-message-committed',
      sessionId: 'happy-session-1',
      agentId: 'opencode',
      localId: 'opencode:message-1',
      body: {
        type: 'message',
        message: 'answer',
      },
      emittedAtMs: Date.now(),
    });
    operations.publish({
      kind: 'transcript-agent-message-committed',
      sessionId: 'happy-session-1',
      agentId: 'opencode',
      localId: 'opencode:message-2',
      body: {
        type: 'message',
        message: 'duplicate evidence',
      },
      emittedAtMs: Date.now(),
    });

    expect(accepted).toEqual([{ userMessageSeq: 42, userMessageSeqs: [42] }]);
  });

  it('does not confirm provider acceptance from evidence emitted before prompt submission resolves', async () => {
    const operations = createOperationsFixture();
    vi.mocked(operations.sendTurnPrompt).mockImplementationOnce(async () => {
      operations.publish({
        kind: 'transcript-agent-message-committed',
        sessionId: 'happy-session-1',
        agentId: 'opencode',
        localId: 'opencode:stale-message',
        body: {
          type: 'message',
          message: 'stale answer',
        },
        emittedAtMs: Date.now(),
      });
    });
    const runtime = createOpenCodePublicSessionRuntime(operations);
    const accepted: Array<Readonly<{ userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });

    await expect(runtime.send({ v: 1, text: 'hello' }, { userMessageSeq: 43 })).resolves.toMatchObject({
      status: 'accepted',
    });

    expect(accepted).toEqual([]);

    operations.publish({
      kind: 'transcript-agent-message-committed',
      sessionId: 'happy-session-1',
      agentId: 'opencode',
      localId: 'opencode:fresh-message',
      body: {
        type: 'message',
        message: 'fresh answer',
      },
      emittedAtMs: Date.now(),
    });

    expect(accepted).toEqual([{ userMessageSeq: 43, userMessageSeqs: [43] }]);
  });

  it('drops pending acceptance after a pre-provider prompt submission failure', async () => {
    const operations = createOperationsFixture();
    const runtime = createOpenCodePublicSessionRuntime(operations);
    const accepted: Array<Readonly<{ userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });

    await expect(runtime.send({ v: 1, text: 'hello' }, { userMessageSeq: 44 })).resolves.toMatchObject({
      status: 'accepted',
    });

    operations.publish({
      kind: 'turn-failed',
      sessionId: 'happy-session-1',
      turnId: 'turn-1',
      emittedAtMs: Date.now(),
      issue: {
        provider: 'opencode',
        code: 'opencode_prompt_submission_failed',
        source: 'agent_session_error',
        message: 'submission failed',
        occurredAt: Date.now(),
      },
    });
    operations.publish({
      kind: 'transcript-agent-message-committed',
      sessionId: 'happy-session-1',
      agentId: 'opencode',
      localId: 'opencode:stale-message',
      body: {
        type: 'message',
        message: 'stale answer after failure',
      },
      emittedAtMs: Date.now(),
    });

    expect(accepted).toEqual([]);
  });

  it('reports pending prompt identity as terminally rejected when OpenCode fails before provider evidence', async () => {
    const operations = createOperationsFixture();
    const runtime = createOpenCodePublicSessionRuntime(operations);
    const accepted: Array<Readonly<{ userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>> = [];
    const terminallyRejected: Array<Readonly<{ userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>> = [];
    runtime.setOnPromptAcceptedByProvider?.((info) => {
      accepted.push(info);
    });
    runtime.setOnPromptTerminallyRejectedBeforeProvider?.((info) => {
      terminallyRejected.push(info);
    });

    await expect(runtime.send({ v: 1, text: 'hello' }, { userMessageSeq: 45 })).resolves.toMatchObject({
      status: 'accepted',
    });

    operations.publish({
      kind: 'turn-failed',
      sessionId: 'happy-session-1',
      turnId: 'turn-1',
      emittedAtMs: Date.now(),
      issue: {
        provider: 'opencode',
        code: 'opencode_prompt_submission_failed',
        source: 'agent_session_error',
        message: 'submission failed',
        occurredAt: Date.now(),
      },
    });
    operations.publish({
      kind: 'transcript-agent-message-committed',
      sessionId: 'happy-session-1',
      agentId: 'opencode',
      localId: 'opencode:stale-message',
      body: {
        type: 'message',
        message: 'stale answer after failure',
      },
      emittedAtMs: Date.now(),
    });

    expect(accepted).toEqual([]);
    expect(terminallyRejected).toEqual([{ userMessageSeq: 45, userMessageSeqs: [45] }]);
  });

  it('does not clear a new active turn when a stale terminal event arrives for the previous turn', async () => {
    const operations = createOperationsFixture();
    const runtime = createOpenCodePublicSessionRuntime(operations);

    await runtime.send({ v: 1, text: 'first' });
    operations.publish({
      kind: 'turn-complete',
      sessionId: 'happy-session-1',
      turnId: 'turn-1',
      emittedAtMs: Date.now(),
    });
    expect(runtime.isTurnInFlight()).toBe(false);

    await runtime.send({ v: 1, text: 'second' });
    expect(runtime.isTurnInFlight()).toBe(true);

    operations.publish({
      kind: 'turn-complete',
      sessionId: 'happy-session-1',
      turnId: 'turn-1',
      emittedAtMs: Date.now(),
    });

    expect(runtime.isTurnInFlight()).toBe(true);
  });

  it('paces completion polling while the OpenCode turn remains active', async () => {
    vi.useFakeTimers();
    const operations = createOperationsFixture();
    const runtime = createOpenCodePublicSessionRuntime(operations);

    try {
      await runtime.send({ v: 1, text: 'hello' });
      await vi.advanceTimersByTimeAsync(0);

      expect(operations.waitForTurnCompletion).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(249);

      expect(operations.waitForTurnCompletion).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);

      expect(operations.waitForTurnCompletion).toHaveBeenCalledTimes(2);
    } finally {
      operations.publish({
        kind: 'turn-complete',
        sessionId: 'happy-session-1',
        turnId: 'turn-1',
        emittedAtMs: Date.now(),
      });
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });
});
