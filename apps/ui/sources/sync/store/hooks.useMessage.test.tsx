import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { useMessage } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

afterEach(() => {
    standardCleanup();
});

describe('useMessage', () => {
    it('does not re-render a different message when another message changes', async () => {
        const previousState = storage.getState();
        try {
            const messagesById: Record<string, any> = {
                'm-1': { id: 'm-1', kind: 'user-text', localId: null, createdAt: 1, text: 'first' },
                'm-2': { id: 'm-2', kind: 'agent-text', localId: null, createdAt: 2, text: 'second', isThinking: false },
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

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useMessage('s-1', 'm-1') as any;
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initialRenderCount = renderCount;

            expect(hook.getCurrent()?.text).toBe('first');

            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessionMessages['s-1'];
                    if (!session) return state;
                    const nextMessagesById = {
                        ...session.messagesById,
                        'm-2': {
                            ...session.messagesById['m-2'],
                            text: 'second updated',
                        },
                    };
                    return {
                        ...state,
                        sessionMessages: {
                            ...state.sessionMessages,
                            's-1': {
                                ...session,
                                messagesById: nextMessagesById,
                                messagesMap: nextMessagesById,
                                messagesVersion: session.messagesVersion + 1,
                            },
                        },
                    };
                });
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()?.text).toBe('first');
            expect(renderCount).toBe(initialRenderCount);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

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

    it('does not recompute the revision-null legacy signature when message reference and messagesVersion are unchanged', async () => {
        const previousState = storage.getState();
        try {
            let legacySignatureReadCount = 0;
            const legacyMessage: Record<string, unknown> = {
                id: 'm-1',
                kind: 'user-text',
                localId: null,
                createdAt: 1,
                text: 'hi',
            };
            Object.defineProperty(legacyMessage, 'legacySignatureProbe', {
                enumerable: true,
                get: () => {
                    legacySignatureReadCount += 1;
                    return 'probe';
                },
            });
            const messagesById: Record<string, any> = {
                'm-1': legacyMessage,
            };

            storage.setState((state) => ({
                ...state,
                isDataReady: false,
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
                        isLoaded: true,
                    },
                },
            }));

            const hook = await renderHook(() => useMessage('s-1', 'm-1') as any, {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()?.text).toBe('hi');
            const readsAfterInitialRender = legacySignatureReadCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    isDataReady: true,
                }));
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()?.text).toBe('hi');
            expect(legacySignatureReadCount).toBe(readsAfterInitialRender);

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
