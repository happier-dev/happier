import React from 'react';
import { afterEach } from 'vitest';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
    createToolCallMessageFixture,
    flushHookEffects,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';

import { useMessagesByIds, useMessagesByRefs } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

afterEach(() => {
    standardCleanup();
});

function writeToolMessage(params: Readonly<{
    sessionId: string;
    message: ReturnType<typeof createToolCallMessageFixture>;
    revision: number;
}>): void {
    storage.setState((state) => {
        const previous = state.sessionMessages[params.sessionId];
        const messagesById = {
            ...(previous?.messagesById ?? {}),
            [params.message.id]: params.message,
        };
        return {
            ...state,
            sessionMessages: {
                ...state.sessionMessages,
                [params.sessionId]: {
                    messageIdsOldestFirst: previous?.messageIdsOldestFirst.includes(params.message.id)
                        ? previous.messageIdsOldestFirst
                        : [...(previous?.messageIdsOldestFirst ?? []), params.message.id],
                    messagesById,
                    messagesMap: messagesById,
                    messageRevisionsById: {
                        ...(previous?.messageRevisionsById ?? {}),
                        [params.message.id]: params.revision,
                    },
                    reducerState: previous?.reducerState ?? ({} as never),
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    messagesVersion: (previous?.messagesVersion ?? 0) + 1,
                    isLoaded: true,
                },
            },
        };
    });
}

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

            const ids = ['m-1', 'missing', 'm-2'] as const;
            const hook = await renderHook(() => useMessagesByIds('s-1', ids), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            const first = hook.getCurrent();
            expect(first.map((message) => message.id)).toEqual(['m-1', 'm-2']);
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

    it('publishes a new selected array when a selected message revision changes in place', async () => {
        const previousState = storage.getState();
        try {
            const message = createToolCallMessageFixture({
                id: 'tool-selected',
                createdAt: 1,
                tool: { state: 'running' } as never,
            });
            writeToolMessage({ sessionId: 's-selected', message, revision: 1 });
            const hook = await renderHook(() => useMessagesByIds('s-selected', ['tool-selected']), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            await act(async () => {
                message.tool.state = 'completed';
                writeToolMessage({ sessionId: 's-selected', message, revision: 2 });
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()).not.toBe(first);
            const selectedMessage = hook.getCurrent()[0];
            expect(selectedMessage?.kind === 'tool-call' ? selectedMessage.tool.state : null).toBe('completed');
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

describe('useMessagesByRefs', () => {
    it('keeps aligned mixed-session results stable until a selected revision changes', async () => {
        const previousState = storage.getState();
        try {
            const first = createToolCallMessageFixture({
                id: 'tool-a',
                createdAt: 1,
                tool: { state: 'completed' } as never,
            });
            const second = createToolCallMessageFixture({
                id: 'tool-b',
                createdAt: 2,
                tool: { state: 'running' } as never,
            });
            writeToolMessage({ sessionId: 'origin-a', message: first, revision: 1 });
            writeToolMessage({ sessionId: 'origin-b', message: second, revision: 1 });
            const refs = [
                { sessionId: 'origin-a', messageId: 'tool-a' },
                { sessionId: 'origin-a', messageId: 'missing' },
                { sessionId: 'origin-b', messageId: 'tool-b' },
            ] as const;
            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useMessagesByRefs(refs);
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initial = hook.getCurrent();
            expect(initial.map((message) => message?.id ?? null)).toEqual(['tool-a', null, 'tool-b']);
            const initialRenderCount = renderCount;

            await act(async () => {
                writeToolMessage({
                    sessionId: 'origin-b',
                    message: createToolCallMessageFixture({ id: 'unrelated', createdAt: 3 }),
                    revision: 1,
                });
                await flushHookEffects({ cycles: 1, turns: 4 });
            });
            expect(hook.getCurrent()).toBe(initial);
            expect(renderCount).toBe(initialRenderCount);

            await act(async () => {
                second.tool.state = 'error';
                writeToolMessage({ sessionId: 'origin-b', message: second, revision: 2 });
                await flushHookEffects({ cycles: 1, turns: 4 });
            });
            expect(hook.getCurrent()).not.toBe(initial);
            const updatedMessage = hook.getCurrent()[2];
            expect(updatedMessage?.kind === 'tool-call' ? updatedMessage.tool.state : null).toBe('error');
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
