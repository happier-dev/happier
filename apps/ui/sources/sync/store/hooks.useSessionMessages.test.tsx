import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

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
            await act(async () => {
                storage.setState(previousState);
            });
        }
    });

    it('returns cached messages while the store ids are temporarily empty during a reset', async () => {
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
            expect(first).toHaveLength(2);

            await act(async () => {
                storage.getState().resetSessionMessages('s-1');
            });

            const afterReset = (await hook.rerender()).messages;
            expect(hook.getCurrent().isLoaded).toBe(false);
            expect(afterReset).toBe(first);
            expect(afterReset).toHaveLength(2);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('returns an empty array when ids are empty and the transcript is marked loaded', async () => {
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
            expect(first).toHaveLength(2);

            await act(async () => {
                storage.getState().resetSessionMessages('s-1');
                storage.getState().applyMessagesLoaded('s-1');
            });

            const afterBadLoaded = (await hook.rerender()).messages;
            expect(hook.getCurrent().isLoaded).toBe(true);
            expect(afterBadLoaded).toEqual([]);

            await hook.unmount();
        } finally {
            await act(async () => {
                storage.setState(previousState);
            });
        }
    });

    it('returns an empty array when ids are empty even if the transcript version is non-zero', async () => {
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
                        messagesVersion: 2,
                        isLoaded: true,
                    },
                },
            }));

            const hook = await renderHook(() => useSessionMessages('s-1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            const first = hook.getCurrent().messages;
            expect(first).toHaveLength(2);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        's-1': {
                            ...(state.sessionMessages['s-1'] as any),
                            messageIdsOldestFirst: [],
                            messagesVersion: 2,
                            isLoaded: true,
                        },
                    },
                }));
            });

            const afterEmptyIds = (await hook.rerender()).messages;
            expect(hook.getCurrent().isLoaded).toBe(true);
            expect(afterEmptyIds).toEqual([]);

            await hook.unmount();
        } finally {
            await act(async () => {
                storage.setState(previousState);
            });
        }
    });

    it('returns an empty array once the transcript is explicitly loaded with no messages', async () => {
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

            expect(hook.getCurrent().messages).toHaveLength(2);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        's-1': {
                            ...(state.sessionMessages['s-1'] as any),
                            messageIdsOldestFirst: [],
                            messagesById: {},
                            messagesMap: {},
                            messagesVersion: 0,
                            isLoaded: true,
                        },
                    },
                }));
            });

            const afterExplicitEmptyLoad = (await hook.rerender()).messages;
            expect(hook.getCurrent().isLoaded).toBe(true);
            expect(afterExplicitEmptyLoad).toEqual([]);

            await hook.unmount();
        } finally {
            await act(async () => {
                storage.setState(previousState);
            });
        }
    });

    it('treats padded session ids as canonical when reading committed messages', async () => {
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

            const hook = await renderHook(() => useSessionMessages('  s-1  '), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().messages).toHaveLength(2);
            expect(hook.getCurrent().isLoaded).toBe(true);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
