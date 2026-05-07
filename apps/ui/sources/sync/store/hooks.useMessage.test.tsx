import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { useMessage } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

afterEach(() => {
    standardCleanup();
});

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
                        reducerState: {} as any,
                        latestThinkingMessageId: null,
                        latestThinkingMessageActivityAtMs: null,
                        messagesVersion: 1,
                        lastAppliedAgentStateVersion: null,
                        isLoaded: true,
                    },
                },
            }));

            const hook = await renderHook(() => useMessage('s-1', 'm-1') as any, {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()?.text).toBe('hi');

            await act(async () => {
                storage.setState((state) => {
                    const session: any = state.sessionMessages['s-1'];
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
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()?.text).toBe('hello');

            await hook.unmount();
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
                        reducerState: {} as any,
                        latestThinkingMessageId: null,
                        latestThinkingMessageActivityAtMs: null,
                        messagesVersion: 1,
                        lastAppliedAgentStateVersion: null,
                        isLoaded: true,
                    },
                },
            }));

            const hook = await renderHook(() => useMessage('s-1', 'm-1') as any, {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()?.text).toBe('hi');

            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessionMessages['s-1'];
                    if (session) {
                        const message = session.messagesById['m-1'];
                        if (message && 'text' in message) {
                            message.text = 'hello';
                        }
                        return {
                            ...state,
                            sessionMessages: {
                                ...state.sessionMessages,
                                's-1': {
                                    ...session,
                                    messagesById: session.messagesById,
                                    messagesMap: session.messagesById,
                                    messagesVersion: session.messagesVersion + 1,
                                },
                            },
                        };
                    }
                    return state;
                });
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()?.text).toBe('hello');

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
