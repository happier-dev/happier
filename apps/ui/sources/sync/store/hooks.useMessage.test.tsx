import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { useMessage } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushEffects(turns = 2): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

describe('useMessage', () => {
  it('re-renders when the message is mutated in-place but messagesVersion increments', async () => {
    const previousState = storage.getState();
    try {
      const messagesById: Record<string, any> = {
        'm-1': { id: 'm-1', kind: 'user-text', localId: null, createdAt: 1, text: 'hi' },
      };

      storage.setState((state) => ({
        ...state,
        sessionMessages: {
          ...state.sessionMessages,
          's-1': {
            messageIdsOldestFirst: ['m-1'],
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

      const seenTexts: string[] = [];

      function Test() {
        const msg = useMessage('s-1', 'm-1') as any;
        React.useEffect(() => {
          seenTexts.push(String(msg?.text ?? ''));
        }, [msg?.text]);
        return null;
      }

      let tree: renderer.ReactTestRenderer | null = null;
      await act(async () => {
        tree = renderer.create(React.createElement(Test));
        await flushEffects(4);
      });

      expect(seenTexts).toEqual(['hi']);

      await act(async () => {
        storage.setState((state) => {
          const session: any = state.sessionMessages['s-1'];
          // Simulate the store's in-place mutation strategy for streaming/perf.
          session.messagesById['m-1'].text = 'hello';
          return {
            ...state,
            sessionMessages: {
              ...state.sessionMessages,
              's-1': {
                ...session,
                messagesById: session.messagesById,
                messagesMap: session.messagesById,
                messagesVersion: (session.messagesVersion ?? 0) + 1,
              },
            },
          };
        });
        await flushEffects(4);
      });

      expect(seenTexts).toEqual(['hi', 'hello']);

      await act(async () => {
        tree?.unmount();
        await flushEffects(2);
      });
    } finally {
      storage.setState(previousState);
    }
  });

  it('re-renders when messagesById is mutated in-place with same reference but new session object', async () => {
    const previousState = storage.getState();
    try {
      const messagesById: Record<string, any> = {
        'm-1': { id: 'm-1', kind: 'user-text', localId: null, createdAt: 1, text: 'hi' },
      };

      storage.setState((state) => ({
        ...state,
        sessionMessages: {
          ...state.sessionMessages,
          's-1': {
            messageIdsOldestFirst: ['m-1'],
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

      const seenTexts: string[] = [];

      function Test() {
        const msg = useMessage('s-1', 'm-1') as any;
        React.useEffect(() => {
          seenTexts.push(String(msg?.text ?? ''));
        }, [msg?.text]);
        return null;
      }

      let tree: renderer.ReactTestRenderer | null = null;
      await act(async () => {
        tree = renderer.create(React.createElement(Test));
        await flushEffects(4);
      });

      expect(seenTexts).toEqual(['hi']);

      // This simulates the actual in-place mutation pattern used in the store:
      // - messagesById is mutated in-place (same reference)
      // - A new session object is created with the same messagesById reference
      // - messagesVersion is incremented
      await act(async () => {
        storage.setState((state) => {
          const session = state.sessionMessages['s-1'];
          if (session) {
            // Mutate the message in-place (this is what happens during streaming)
            const message = session.messagesById['m-1'];
            if (message && 'text' in message) {
              message.text = 'hello';
            }
            // Create a new session object with the same messagesById reference
            return {
              ...state,
              sessionMessages: {
                ...state.sessionMessages,
                's-1': {
                  ...session,
                  messagesById: session.messagesById, // Same reference!
                  messagesMap: session.messagesById,
                  messagesVersion: session.messagesVersion + 1,
                },
              },
            };
          }
          return state;
        });
        await flushEffects(4);
      });

      // This should pass: even though messagesById has the same reference,
      // the new session object and incremented messagesVersion should trigger a re-render
      expect(seenTexts).toEqual(['hi', 'hello']);

      await act(async () => {
        tree?.unmount();
        await flushEffects(2);
      });
    } finally {
      storage.setState(previousState);
    }
  });
});
