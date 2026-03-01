import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useMessagesByIds } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushEffects(turns = 2): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

describe('useMessagesByIds', () => {
  it('returns a referentially stable array when store state is unchanged', async () => {
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

      const ids = ['m-1', 'm-2'] as const;
      const seen: any[] = [];
      let bump: (() => void) | null = null;

      function Test() {
        const [tick, setTick] = React.useState(0);
        const msgs = useMessagesByIds('s-1', ids);
        React.useEffect(() => {
          seen.push(msgs);
        }, [tick]); // capture per-render value
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

  it('does not trigger React 18 external-store snapshot warnings (getSnapshot should be cached)', async () => {
    const previousState = storage.getState();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
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

      const ids = ['m-1', 'm-2'] as const;

      function Test() {
        useMessagesByIds('s-1', ids);
        return null;
      }

      let tree: renderer.ReactTestRenderer | null = null;
      await act(async () => {
        tree = renderer.create(React.createElement(React.StrictMode, null, React.createElement(Test)));
        await flushEffects(4);
      });

      const allMessages = spy.mock.calls.map((c) => String(c[0] ?? ''));
      expect(allMessages.some((m) => m.includes('getSnapshot') && m.includes('cached'))).toBe(false);

      await act(async () => {
        tree?.unmount();
        await flushEffects(2);
      });
    } finally {
      storage.setState(previousState);
      spy.mockRestore();
    }
  });
});
