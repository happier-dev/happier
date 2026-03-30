import { describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storageStore';

import { useUserMessageHistory } from './useUserMessageHistory';
import { renderHook } from '@/dev/testkit';

describe('useUserMessageHistory', () => {
  it('returns a referentially stable navigator when store state is unchanged', async () => {
    const previousState = storage.getState();
    try {
      const messagesById = {
        u1: { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' } as any,
        a1: { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'ok', isThinking: false } as any,
        u2: { kind: 'user-text', id: 'u2', localId: null, createdAt: 3, text: 'bye' } as any,
      };

      storage.setState((state) => ({
        ...state,
        sessionMessages: {
          ...state.sessionMessages,
          s1: {
            messageIdsOldestFirst: ['u1', 'a1', 'u2'],
            messagesById,
            messagesMap: messagesById,
            reducerState: {} as any,
            latestThinkingMessageId: null,
            latestThinkingMessageActivityAtMs: null,
            messagesVersion: 1,
            isLoaded: true,
          },
        },
      }));

      const hook = await renderHook(() =>
        useUserMessageHistory({ scope: 'global', sessionId: null, maxEntries: 20 }),
      );

      const first = hook.getCurrent();

      await hook.rerender();

      expect(hook.getCurrent()).toBe(first);

      await hook.unmount();
    } finally {
      storage.setState(previousState);
    }
  });
});
