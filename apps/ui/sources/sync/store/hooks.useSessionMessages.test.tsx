import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { useSessionMessages } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushEffects(turns = 2): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

describe('useSessionMessages', () => {
  it('returns a referentially stable messages array when store state is unchanged', async () => {
    const previousState = storage.getState();
    try {
      storage.setState((state) => ({
        ...state,
        sessionMessages: {
          ...state.sessionMessages,
          's-1': {
            messageIdsOldestFirst: ['m-1', 'm-2'],
            messagesById: {
              'm-1': { id: 'm-1', kind: 'user-text', localId: null, createdAt: 1, text: 'hi' } as any,
              'm-2': { id: 'm-2', kind: 'agent-text', localId: null, createdAt: 2, text: 'hello', isThinking: false } as any,
            },
            messagesMap: {},
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
        const { messages } = useSessionMessages('s-1');
        React.useEffect(() => {
          seen.push(messages);
        }, [tick, messages]);
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
      expect(Array.isArray(first)).toBe(true);
      expect(first.length).toBe(2);

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
