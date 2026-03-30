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

import { waitForNextAssistantTextMessage } from './waitForNextAssistantTextMessage';

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
});
