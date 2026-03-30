import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useSessionMessages } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

afterEach(() => {
    standardCleanup();
});

describe('useSessionMessages', () => {
    it('returns a referentially stable messages array when store state is unchanged', async () => {
        const previousState = storage.getState();
        try {
            const messagesById = {
                'm-1': { id: 'm-1', kind: 'user-text', localId: null, createdAt: 1, text: 'hi' } as any,
                'm-2': { id: 'm-2', kind: 'agent-text', localId: null, createdAt: 2, text: 'hello', isThinking: false } as any,
            };

            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    's-1': {
                        messageIdsOldestFirst: ['m-1', 'm-2'],
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

            const hook = await renderHook(() => useSessionMessages('s-1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            const first = hook.getCurrent().messages;
            expect(Array.isArray(first)).toBe(true);
            expect(first).toHaveLength(2);

            const second = (await hook.rerender()).messages;
            expect(second).toBe(first);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
