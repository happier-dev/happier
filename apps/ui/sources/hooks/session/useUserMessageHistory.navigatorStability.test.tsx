import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storageStore';

import { useUserMessageHistory } from './useUserMessageHistory';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushEffects(turns = 2): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

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
            draftsByLocalId: {},
            reducerState: {} as any,
            latestThinkingMessageId: null,
            latestThinkingMessageActivityAtMs: null,
            messagesVersion: 1,
            isLoaded: true,
          },
        },
      }));

      const seen: any[] = [];
      let bump: (() => void) | null = null;

      function Test() {
        const [tick, setTick] = React.useState(0);
        const history = useUserMessageHistory({ scope: 'global', sessionId: null, maxEntries: 20 });
        React.useEffect(() => {
          seen.push(history);
        }, [tick]);
        bump = () => setTick((t) => t + 1);
        return null;
      }

      let tree: renderer.ReactTestRenderer | null = null;
      await act(async () => {
        tree = renderer.create(React.createElement(Test));
        await flushEffects(4);
      });

      expect(seen.length).toBe(1);
      const first = seen[0];

      await act(async () => {
        bump?.();
        await flushEffects(4);
      });

      expect(seen.length).toBe(2);
      const second = seen[1];
      expect(second).toBe(first);

      await act(async () => {
        tree?.unmount();
        await flushEffects(2);
      });
    } finally {
      storage.setState(previousState);
    }
  });
});
