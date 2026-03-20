import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { useSessionMessagesReducerState } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushEffects(turns = 2): Promise<void> {
    for (let i = 0; i < turns; i += 1) {
        await Promise.resolve();
    }
}

describe('useSessionMessagesReducerState', () => {
    it('re-renders when reducerState mutates but reference stays stable', async () => {
        const previousState = storage.getState();
        try {
            const reducerState = { value: 0 } as any;
            const messagesById: Record<string, any> = {};

            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    's-1': {
                        messageIdsOldestFirst: [],
                        messagesById,
                        messagesMap: messagesById,
                        draftsByLocalId: {},
                        reducerState,
                        latestThinkingMessageId: null,
                        latestThinkingMessageActivityAtMs: null,
                        messagesVersion: 0,
                        reducerVersion: 0,
                        isLoaded: true,
                    } as any,
                },
            }));

            const seen: number[] = [];

            function Test() {
                const state = useSessionMessagesReducerState('s-1') as any;
                React.useEffect(() => {
                    seen.push(state?.value ?? -1);
                });
                return null;
            }

            let tree: renderer.ReactTestRenderer | null = null;
            await act(async () => {
                tree = renderer.create(React.createElement(Test));
                await flushEffects(4);
            });

            expect(seen).toEqual([0]);

            await act(async () => {
                reducerState.value = 1;
                storage.setState((state) => ({
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        's-1': {
                            ...(state.sessionMessages as any)['s-1'],
                            reducerState,
                            reducerVersion: 1,
                        },
                    },
                }));
                await flushEffects(4);
            });

            expect(seen).toEqual([0, 1]);

            await act(async () => {
                tree?.unmount();
                await flushEffects(2);
            });
        } finally {
            storage.setState(previousState);
        }
    });
});
