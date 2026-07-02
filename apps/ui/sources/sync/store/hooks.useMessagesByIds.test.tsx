import React from 'react';
import { afterEach } from 'vitest';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useMessagesByIds } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

afterEach(() => {
    standardCleanup();
});

describe('useMessagesByIds', () => {
    it('returns a referentially stable array when store state is unchanged', async () => {
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

            const ids = ['m-1', 'm-2'] as const;
            const hook = await renderHook(() => useMessagesByIds('s-1', ids), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            const first = hook.getCurrent();
            const second = await hook.rerender();
            expect(second).toBe(first);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps the selected array stable when an unrelated message changes', async () => {
        const previousState = storage.getState();
        try {
            const messagesById = {
                'm-1': { id: 'm-1', kind: 'tool-call', localId: null, createdAt: 1, tool: { id: 'tool-1', state: 'completed' }, children: [] } as any,
                'm-2': { id: 'm-2', kind: 'tool-call', localId: null, createdAt: 2, tool: { id: 'tool-2', state: 'completed' }, children: [] } as any,
                'm-3': { id: 'm-3', kind: 'agent-text', localId: null, createdAt: 3, text: 'before', isThinking: true } as any,
            };

            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    's-1': {
                        messageIdsOldestFirst: ['m-1', 'm-2', 'm-3'],
                        messagesById,
                        messagesMap: messagesById,
                        reducerState: {} as any,
                        latestThinkingMessageId: 'm-3',
                        latestThinkingMessageActivityAtMs: 1,
                        messagesVersion: 1,
                        isLoaded: true,
                    },
                },
            }));

            const ids = ['m-1', 'm-2'] as const;
            const hook = await renderHook(() => useMessagesByIds('s-1', ids), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            const first = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessionMessages['s-1']!;
                    const nextMessagesById = {
                        ...session.messagesById,
                        'm-3': {
                            ...session.messagesById['m-3'],
                            text: 'after',
                        } as any,
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
            });

            const second = await hook.rerender();
            expect(second).toBe(first);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not trigger React 18 external-store snapshot warnings (getSnapshot should be cached)', async () => {
        const previousState = storage.getState();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
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

            const ids = ['m-1', 'm-2'] as const;
            function StrictModeWrapper({ children }: React.PropsWithChildren) {
                return <React.StrictMode>{children}</React.StrictMode>;
            }

            const hook = await renderHook(() => useMessagesByIds('s-1', ids), {
                wrapper: StrictModeWrapper,
                flushOptions: { cycles: 1, turns: 4 },
            });

            const allMessages = spy.mock.calls.map((c) => String(c[0] ?? ''));
            expect(allMessages.some((m) => m.includes('getSnapshot') && m.includes('cached'))).toBe(false);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
            spy.mockRestore();
        }
    });
});
