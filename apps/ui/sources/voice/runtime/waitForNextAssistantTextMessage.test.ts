import { describe, expect, it, vi } from 'vitest';

const state: { current: any } = {
  current: { sessionMessages: { s1: { messages: [] } } },
};

const listeners = new Set<() => void>();

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
    getState: () => state.current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
});
});

import {
  captureSessionTurnBaseline,
  collectAssistantTextMessagesSinceBaseline,
  waitForNextAssistantTextMessage,
  waitForTurnFinalAssistantText,
} from './waitForNextAssistantTextMessage';
import { setReceivedSessionMessageApplier } from '@/sync/engine/sessions/sessionMessageMaterializationBarrier';

function notify() {
  listeners.forEach((listener) => listener());
}

function liveSession(overrides: Record<string, unknown>) {
  const now = Date.now();
  return { id: 's1', active: true, activeAt: now, presence: 'online', thinking: false, thinkingAt: 0, ...overrides };
}

describe('waitForNextAssistantTextMessage', () => {
  it('resolves null when aborted', async () => {
    const sessionId = 's1';
    state.current = { sessionMessages: { [sessionId]: { messages: [] } } };

    const baselineIds = new Set<string>();
    const abortController = new AbortController();

    const waitWithSignal =
      waitForNextAssistantTextMessage as unknown as (
        sessionId: string,
        baselineIds: Set<string>,
        baselineCount: number,
        timeoutMs: number,
        signal?: AbortSignal,
      ) => Promise<string | null>;

    const waitPromise = waitWithSignal(sessionId, baselineIds, 0, 60_000, abortController.signal);

    abortController.abort();

    await expect(waitPromise).resolves.toBe(null);
  });

  it('reads assistant replies from normalized transcript state', async () => {
    const sessionId = 's1';
    state.current = {
      sessionMessages: {
        [sessionId]: {
          messageIdsOldestFirst: ['m1'],
          messagesById: {
            m1: { id: 'm1', kind: 'user-text', text: 'hello' },
          },
          messagesMap: {
            m1: { id: 'm1', kind: 'user-text', text: 'hello' },
          },
        },
      },
    };

    const waitPromise = waitForNextAssistantTextMessage(sessionId, new Set(['m1']), 1, 60_000);

    state.current = {
      sessionMessages: {
        [sessionId]: {
          messageIdsOldestFirst: ['m1', 'm2'],
          messagesById: {
            m1: { id: 'm1', kind: 'user-text', text: 'hello' },
            m2: { id: 'm2', kind: 'agent-text', text: 'assistant reply' },
          },
          messagesMap: {
            m1: { id: 'm1', kind: 'user-text', text: 'hello' },
            m2: { id: 'm2', kind: 'agent-text', text: 'assistant reply' },
          },
        },
      },
    };
    listeners.forEach((listener) => listener());

    await expect(waitPromise).resolves.toBe('assistant reply');
  });

  it('excludes thinking and peer deliveries from recovered assistant replies', () => {
    state.current = {
      sessionMessages: {
        s1: {
          messages: [
            { id: 't1', kind: 'agent-text', text: 'pondering the request', isThinking: true },
            { id: 'p1', kind: 'agent-text', text: 'A teammate update', peer: { name: 'reviewer', handback: false } },
            { id: 'a1', kind: 'agent-text', text: 'Here is the answer' },
            { id: 'p2', kind: 'agent-text', text: 'A subagent report', peer: { name: 'worker', handback: true } },
          ],
        },
      },
    };

    expect(collectAssistantTextMessagesSinceBaseline('s1', new Set(), 0)).toEqual(['Here is the answer']);
  });

  it('waits for the session turn to finish and returns its final assistant text', async () => {
    state.current = {
      sessions: { s1: liveSession({ latestTurnId: 'turn-0', latestTurnStatus: 'completed', latestTurnStatusObservedAt: Date.now() - 5_000 }) },
      sessionMessages: { s1: { messages: [{ id: 'old', kind: 'agent-text', text: 'previous reply' }] } },
    };
    const baseline = captureSessionTurnBaseline('s1');
    let settled: string | null | undefined;
    const waitPromise = waitForTurnFinalAssistantText({ sessionId: 's1', baseline }).then((text) => {
      settled = text;
      return text;
    });

    state.current = {
      sessions: { s1: liveSession({ latestTurnId: 'turn-1', latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: Date.now() }) },
      sessionMessages: {
        s1: {
          messages: [
            { id: 'old', kind: 'agent-text', text: 'previous reply' },
            { id: 't1', kind: 'agent-text', text: 'pondering', isThinking: true },
            { id: 'a1', kind: 'agent-text', text: 'Let me check the files.' },
          ],
        },
      },
    };
    notify();
    await Promise.resolve();
    expect(settled).toBeUndefined();

    state.current = {
      sessions: { s1: liveSession({ latestTurnId: 'turn-1', latestTurnStatus: 'completed', latestTurnStatusObservedAt: Date.now() }) },
      sessionMessages: {
        s1: {
          messages: [
            { id: 'old', kind: 'agent-text', text: 'previous reply' },
            { id: 't1', kind: 'agent-text', text: 'pondering', isThinking: true },
            { id: 'a1', kind: 'agent-text', text: 'Let me check the files.' },
            { id: 'tc1', kind: 'tool-call', tool: { name: 'Read' } },
            { id: 'a2', kind: 'agent-text', text: 'All tests pass now.' },
          ],
        },
      },
    };
    notify();

    await expect(waitPromise).resolves.toBe('All tests pass now.');
  });

  it('resolves null when aborted while the turn is still running', async () => {
    state.current = {
      sessions: { s1: liveSession({ latestTurnId: 'turn-1', latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: Date.now() }) },
      sessionMessages: { s1: { messages: [] } },
    };
    const abortController = new AbortController();
    const waitPromise = waitForTurnFinalAssistantText({
      sessionId: 's1',
      baseline: captureSessionTurnBaseline('s1'),
      signal: abortController.signal,
    });
    abortController.abort();
    await expect(waitPromise).resolves.toBe(null);
  });

  function turnState(turnId: string, status: string, messages: any[], extra: Record<string, unknown> = {}) {
    return {
      sessions: { s1: liveSession({ latestTurnId: turnId, latestTurnStatus: status, latestTurnStatusObservedAt: Date.now(), ...extra }) },
      sessionMessages: { s1: { messages } },
    };
  }

  it('applies already-received messages before reading the final reply when the turn status lands first', async () => {
    state.current = turnState('turn-0', 'completed', []);
    const baseline = captureSessionTurnBaseline('s1');
    const interim = { id: 'a1', kind: 'agent-text', text: 'Let me check.' };
    const toolCall = { id: 'tc1', kind: 'tool-call', tool: { name: 'Bash' } };
    const finalReply = { id: 'a2', kind: 'agent-text', text: 'Everything passes.' };
    // The final reply was received but is still held by the socket apply coalescer.
    setReceivedSessionMessageApplier(() => {
      state.current = { ...state.current, sessionMessages: { s1: { messages: [interim, toolCall, finalReply] } } };
    });
    try {
      const waitPromise = waitForTurnFinalAssistantText({ sessionId: 's1', baseline });
      state.current = turnState('turn-1', 'in_progress', [interim]);
      notify();
      state.current = turnState('turn-1', 'completed', [interim]);
      notify();

      await expect(waitPromise).resolves.toBe('Everything passes.');
    } finally {
      setReceivedSessionMessageApplier(() => {});
    }
  });

  it('ignores the completion of a turn that was already running at baseline', async () => {
    const earlier = { id: 'e1', kind: 'agent-text', text: 'Earlier turn reply.' };
    state.current = turnState('turn-a', 'in_progress', []);
    const baseline = captureSessionTurnBaseline('s1');
    let settled: string | null | undefined;
    const waitPromise = waitForTurnFinalAssistantText({ sessionId: 's1', baseline }).then((text) => {
      settled = text;
      return text;
    });

    state.current = turnState('turn-a', 'completed', [earlier]);
    notify();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeUndefined();

    state.current = turnState('turn-b', 'in_progress', [earlier]);
    notify();
    state.current = turnState('turn-b', 'completed', [
      earlier,
      { id: 'u1', kind: 'user-text', text: 'my question' },
      { id: 'b1', kind: 'agent-text', text: 'Your answer.' },
    ]);
    notify();

    await expect(waitPromise).resolves.toBe('Your answer.');
  });

  it('does not treat a keep-alive thinkingAt refresh as the end of the turn', async () => {
    state.current = turnState('turn-a', 'in_progress', [], { thinking: true, thinkingAt: Date.now() - 1_000 });
    const baseline = captureSessionTurnBaseline('s1');
    let settled: string | null | undefined;
    void waitForTurnFinalAssistantText({ sessionId: 's1', baseline }).then((text) => {
      settled = text;
    });

    // Activity flush mirrors activeAt into thinkingAt while the turn is still non-terminal.
    state.current = turnState('turn-a', 'in_progress', [{ id: 'a1', kind: 'agent-text', text: 'partial' }], {
      thinking: false,
      thinkingAt: Date.now(),
      latestTurnStatusObservedAt: Date.now() - 200_000,
      activeAt: Date.now() - 200_000,
    });
    notify();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeUndefined();
  });

  it('speaks every reply after the last tool call of the turn, skipping thinking', async () => {
    state.current = turnState('turn-0', 'completed', []);
    const baseline = captureSessionTurnBaseline('s1');
    const waitPromise = waitForTurnFinalAssistantText({ sessionId: 's1', baseline });
    state.current = turnState('turn-1', 'completed', [
      { id: 'a1', kind: 'agent-text', text: 'Running the tests.' },
      { id: 'tc1', kind: 'tool-call', tool: { name: 'Bash' } },
      { id: 'a2', kind: 'agent-text', text: 'All 12 tests pass.' },
      { id: 't1', kind: 'agent-text', text: 'reflecting', isThinking: true },
      { id: 'a3', kind: 'agent-text', text: 'Want me to commit?' },
    ]);
    notify();

    await expect(waitPromise).resolves.toBe('All 12 tests pass.\n\nWant me to commit?');
  });
});
