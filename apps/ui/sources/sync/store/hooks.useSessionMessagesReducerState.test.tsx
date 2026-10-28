import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { useSessionMessagesReducerState } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

afterEach(() => {
    standardCleanup();
});

describe('useSessionMessagesReducerState', () => {
    const seedSession = (reducerState: unknown, reducerVersion: number) => {
        storage.setState((state) => ({
            ...state,
            sessionMessages: {
                ...state.sessionMessages,
                's-1': {
                    messageIdsOldestFirst: [],
                    messagesById: {},
                    messagesMap: {},
                    reducerState,
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    messagesVersion: 0,
                    reducerVersion,
                    isLoaded: true,
                } as any,
            },
        }));
    };

    it('does not re-render on message churn when disabled', async () => {
        const previousState = storage.getState();
        try {
            seedSession({ value: 0 }, 0);

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionMessagesReducerState('s-1', false);
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initialRenderCount = renderCount;

            expect(hook.getCurrent()).toBeNull();

            await act(async () => {
                seedSession({ value: 1 }, 1);
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()).toBeNull();
            expect(renderCount).toBe(initialRenderCount);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

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
                        reducerState,
                        latestThinkingMessageId: null,
                        latestThinkingMessageActivityAtMs: null,
                        latestReadyEventSeq: null,
                        latestReadyEventAt: null,
                        messagesVersion: 0,
                        reducerVersion: 0,
                        isLoaded: true,
                    } as any,
                },
            }));

            const hook = await renderHook(() => useSessionMessagesReducerState('s-1') as any, {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()?.value).toBe(0);

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
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()?.value).toBe(1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
