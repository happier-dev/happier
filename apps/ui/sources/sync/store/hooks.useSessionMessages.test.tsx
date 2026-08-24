import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useSessionMessages, useSessionSubagentSourceMessages, useSessionTranscriptIds } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

afterEach(() => {
    standardCleanup();
});

describe('useSessionMessages', () => {
    it('keeps transcript ids stable when message content changes without id changes', async () => {
        const previousState = storage.getState();
        try {
            const messagesById = {
                'm-1': { id: 'm-1', kind: 'user-text', localId: null, createdAt: 1, text: 'hi' } as any,
                'm-2': { id: 'm-2', kind: 'agent-text', localId: null, createdAt: 2, text: 'hello', isThinking: true } as any,
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
                        latestThinkingMessageId: 'm-2',
                        latestThinkingMessageActivityAtMs: 2,
                        latestReadyEventSeq: null,
                        latestReadyEventAt: null,
                        messagesVersion: 1,
                        lastAppliedAgentStateVersion: null,
                        isLoaded: true,
                    },
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionTranscriptIds('s-1');
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const firstIds = hook.getCurrent().ids;
            const initialRenderCount = renderCount;

            expect(firstIds).toEqual(['m-1', 'm-2']);

            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessionMessages['s-1'];
                    if (!session) return state;
                    const nextMessagesById = {
                        ...session.messagesById,
                        'm-2': {
                            ...session.messagesById['m-2'],
                            text: 'hello streaming update',
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
            });

            expect(hook.getCurrent().ids).toBe(firstIds);
            expect(renderCount).toBe(initialRenderCount);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not subscribe to message updates when disabled', async () => {
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
                        latestReadyEventSeq: null,
                        latestReadyEventAt: null,
                        messagesVersion: 1,
                        lastAppliedAgentStateVersion: null,
                        isLoaded: true,
                    },
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionMessages('s-1', { enabled: false });
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initialRenderCount = renderCount;

            expect(hook.getCurrent().isLoaded).toBe(false);
            expect(hook.getCurrent().messages).toHaveLength(0);

            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessionMessages['s-1'];
                    if (!session) return state;
                    const nextMessagesById = {
                        ...session.messagesById,
                        'm-2': {
                            ...session.messagesById['m-2'],
                            text: 'streamed update',
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
            });

            expect(hook.getCurrent().messages).toHaveLength(0);
            expect(renderCount).toBe(initialRenderCount);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

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
                        latestReadyEventSeq: null,
                        latestReadyEventAt: null,
                        messagesVersion: 1,
                        lastAppliedAgentStateVersion: null,
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
                        latestReadyEventSeq: null,
                        latestReadyEventAt: null,
                        messagesVersion: 1,
                        lastAppliedAgentStateVersion: null,
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
            await act(async () => {
                storage.setState(previousState);
            });
        }
    });

    it('derives committed messages from the populated message map when ids are empty but the transcript is incorrectly marked loaded', async () => {
        const previousState = storage.getState();
        try {
            const messagesById = {
                'm-1': { id: 'm-1', kind: 'user-text', localId: null, createdAt: 1, text: 'hi', seq: 1 } as any,
                'm-2': { id: 'm-2', kind: 'agent-text', localId: null, createdAt: 2, text: 'hello', isThinking: false, seq: 2 } as any,
            };

            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    's-1': {
                        messageIdsOldestFirst: [],
                        messagesById,
                        messagesMap: messagesById,
                        reducerState: {} as any,
                        latestThinkingMessageId: null,
                        latestThinkingMessageActivityAtMs: null,
                        latestReadyEventSeq: null,
                        latestReadyEventAt: null,
                        messagesVersion: 2,
                        lastAppliedAgentStateVersion: null,
                        isLoaded: true,
                    },
                },
            }));

            const hook = await renderHook(() => useSessionMessages('s-1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().isLoaded).toBe(true);
            expect(hook.getCurrent().messages.map((message) => message.id)).toEqual(['m-1', 'm-2']);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('uses transcript block order when deriving committed messages from the populated message map fallback', async () => {
        const previousState = storage.getState();
        try {
            const messagesById = {
                'z-text': {
                    id: 'z-text',
                    kind: 'agent-text',
                    localId: null,
                    createdAt: 2_000,
                    text: 'Text before the question.',
                    isThinking: false,
                    seq: 10,
                    transcriptBlockIndex: 0,
                } as any,
                'a-tool': {
                    id: 'a-tool',
                    kind: 'tool-call',
                    localId: null,
                    createdAt: 2_000,
                    tool: {
                        id: 'ask1',
                        name: 'AskUserQuestion',
                        state: 'running',
                        input: { questions: [{ question: 'Choose a path' }] },
                        createdAt: 2_000,
                        startedAt: 2_000,
                        completedAt: null,
                        description: null,
                    },
                    children: [],
                    seq: 10,
                    transcriptBlockIndex: 1,
                } as any,
            };

            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    's-1': {
                        messageIdsOldestFirst: [],
                        messagesById,
                        messagesMap: messagesById,
                        reducerState: {} as any,
                        latestThinkingMessageId: null,
                        latestThinkingMessageActivityAtMs: null,
                        latestReadyEventSeq: null,
                        latestReadyEventAt: null,
                        messagesVersion: 3,
                        lastAppliedAgentStateVersion: null,
                        isLoaded: true,
                    },
                },
            }));

            const hook = await renderHook(() => useSessionMessages('s-1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().isLoaded).toBe(true);
            expect(hook.getCurrent().messages.map((message) => message.id)).toEqual(['z-text', 'a-tool']);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});

describe('useSessionTranscriptIds retained-content window', () => {
    const messagesById = {
        'm-1': { id: 'm-1', kind: 'user-text', localId: null, createdAt: 1, text: 'hi' } as any,
        'm-2': { id: 'm-2', kind: 'agent-text', localId: null, createdAt: 2, text: 'hello', isThinking: false } as any,
    };

    function seedLoadedTranscript(): void {
        storage.setState((state) => ({
            ...state,
            sessionMessages: {
                ...state.sessionMessages,
                's-retained': {
                    messageIdsOldestFirst: ['m-1', 'm-2'],
                    messagesById,
                    messagesMap: messagesById,
                    reducerState: {} as any,
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    messagesVersion: 1,
                    lastAppliedAgentStateVersion: null,
                    isLoaded: true,
                } as any,
            },
        }));
    }

    /**
     * `resetSessionMessages` empties the ids for the reset -> refetch window while
     * `useSessionMessages` keeps serving its cached rows. Every consumer that decides whether the
     * transcript has anything to show reads this hook, so the window has to be reported — reading
     * `ids.length` alone says "nothing here" and unmounts a transcript the reader is looking at.
     */
    it('reports retained content while a real reset empties the ids, and stops once loaded', async () => {
        const previousState = storage.getState();
        try {
            seedLoadedTranscript();
            const hook = await renderHook(() => useSessionTranscriptIds('s-retained'), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(hook.getCurrent().ids).toHaveLength(2);
            expect(hook.getCurrent().hasRetainedContent).toBe(false);

            await act(async () => {
                storage.getState().resetSessionMessages('s-retained');
            });
            const afterReset = await hook.rerender();

            // The window: ids are gone, the entry is not, the load has not finished.
            expect(afterReset.ids).toHaveLength(0);
            expect(afterReset.isLoaded).toBe(false);
            expect(afterReset.hasRetainedContent).toBe(true);

            // The refetch lands: retention ends, the real content takes over.
            await act(async () => {
                seedLoadedTranscript();
            });
            const afterRefetch = await hook.rerender();
            expect(afterRefetch.ids).toHaveLength(2);
            expect(afterRefetch.hasRetainedContent).toBe(false);

            await hook.unmount();
        } finally {
            await act(async () => {
                storage.setState(previousState);
            });
        }
    });

    it('reports no retained content for an evicted entry or a genuinely empty loaded transcript', async () => {
        const previousState = storage.getState();
        try {
            seedLoadedTranscript();
            const hook = await renderHook(() => useSessionTranscriptIds('s-retained'), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(hook.getCurrent().ids).toHaveLength(2);

            // Eviction removes the entry entirely. Nothing may be retained for a session whose
            // transcript memory was released — that is the no-mounted-surface path.
            await act(async () => {
                storage.getState().evictSessionMessages('s-retained');
            });
            const afterEvict = await hook.rerender();
            expect(afterEvict.ids).toHaveLength(0);
            expect(afterEvict.hasRetainedContent).toBe(false);

            // A loaded transcript that is simply empty is a terminal state, not a window.
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        's-retained': {
                            messageIdsOldestFirst: [],
                            messagesById: {},
                            messagesMap: {},
                            reducerState: {} as any,
                            latestThinkingMessageId: null,
                            latestThinkingMessageActivityAtMs: null,
                            latestReadyEventSeq: null,
                            latestReadyEventAt: null,
                            messagesVersion: 0,
                            lastAppliedAgentStateVersion: null,
                            isLoaded: true,
                        } as any,
                    },
                }));
            });
            const afterEmptyLoaded = await hook.rerender();
            expect(afterEmptyLoaded.hasRetainedContent).toBe(false);

            await hook.unmount();
        } finally {
            await act(async () => {
                storage.setState(previousState);
            });
        }
    });
});

describe('useSessionSubagentSourceMessages', () => {
    it('does not rescan ordinary streamed text when subagent source inputs are unchanged', async () => {
        const previousState = storage.getState();
        try {
            const messagesById = {
                'm-1': {
                    id: 'm-1',
                    kind: 'agent-text',
                    localId: null,
                    createdAt: 1,
                    text: 'Streaming markdown',
                    children: [],
                } as any,
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
                        latestReadyEventSeq: null,
                        latestReadyEventAt: null,
                        messagesVersion: 1,
                        subagentSourceVersion: 0,
                        lastAppliedAgentStateVersion: null,
                        isLoaded: true,
                    },
                },
            }));

            const hook = await renderHook(() => useSessionSubagentSourceMessages('s-1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initialMessages = hook.getCurrent();
            expect(initialMessages).toEqual([]);

            const unreadableMessagesById = {} as Record<string, any>;
            Object.defineProperty(unreadableMessagesById, 'm-1', {
                enumerable: true,
                get() {
                    throw new Error('ordinary streamed text should not be scanned');
                },
            });

            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessionMessages['s-1'];
                    if (!session) return state;
                    return {
                        ...state,
                        sessionMessages: {
                            ...state.sessionMessages,
                            's-1': {
                                ...session,
                                messagesById: unreadableMessagesById,
                                messagesMap: unreadableMessagesById,
                                messagesVersion: session.messagesVersion + 1,
                                subagentSourceVersion: session.subagentSourceVersion,
                            },
                        },
                    };
                });
            });

            expect(hook.getCurrent()).toBe(initialMessages);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not re-render when ordinary agent text streams', async () => {
        const previousState = storage.getState();
        try {
            const messagesById = {
                'm-1': {
                    id: 'm-1',
                    kind: 'tool-call',
                    localId: null,
                    createdAt: 1,
                    tool: {
                        id: 'tool-1',
                        name: 'SubAgentRun',
                        state: 'running',
                        input: { runId: 'run_12345678' },
                        result: null,
                    },
                    children: [],
                } as any,
                'm-2': {
                    id: 'm-2',
                    kind: 'agent-text',
                    localId: null,
                    createdAt: 2,
                    text: 'Streaming markdown',
                    children: [],
                } as any,
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
                        latestReadyEventSeq: null,
                        latestReadyEventAt: null,
                        messagesVersion: 1,
                        lastAppliedAgentStateVersion: null,
                        isLoaded: true,
                    },
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionSubagentSourceMessages('s-1');
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initialRenderCount = renderCount;
            const initialMessages = hook.getCurrent();

            expect(initialMessages.map((message) => message.id)).toEqual(['m-1']);

            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessionMessages['s-1'];
                    if (!session) return state;
                    const nextMessagesById = {
                        ...session.messagesById,
                        'm-2': {
                            ...session.messagesById['m-2'],
                            text: 'Streaming markdown with more tokens',
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
            });

            expect(hook.getCurrent()).toBe(initialMessages);
            expect(renderCount).toBe(initialRenderCount);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not re-render when execution-run signal text streams without changing run identity', async () => {
        const previousState = storage.getState();
        try {
            const messagesById = {
                'm-1': {
                    id: 'm-1',
                    kind: 'tool-call',
                    localId: null,
                    createdAt: 1,
                    tool: {
                        id: 'tool-1',
                        name: 'SubAgentRun',
                        state: 'running',
                        input: { runId: 'run_12345678' },
                        result: null,
                    },
                    children: [],
                } as any,
                'm-2': {
                    id: 'm-2',
                    kind: 'agent-text',
                    localId: null,
                    createdAt: 2,
                    text: 'Execution run has been started: run_12345678',
                    children: [],
                } as any,
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
                        latestReadyEventSeq: null,
                        latestReadyEventAt: null,
                        messagesVersion: 1,
                        lastAppliedAgentStateVersion: null,
                        isLoaded: true,
                    },
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionSubagentSourceMessages('s-1');
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initialRenderCount = renderCount;
            const initialMessages = hook.getCurrent();

            expect(initialMessages.map((message) => message.id)).toEqual(['m-1', 'm-2']);

            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessionMessages['s-1'];
                    if (!session) return state;
                    const nextMessagesById = {
                        ...session.messagesById,
                        'm-2': {
                            ...session.messagesById['m-2'],
                            text: 'Execution run has been started: run_12345678 and is still running',
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
            });

            expect(hook.getCurrent()).toBe(initialMessages);
            expect(renderCount).toBe(initialRenderCount);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not re-render when a running subagent tool only updates progress result text', async () => {
        const previousState = storage.getState();
        try {
            const messagesById = {
                'm-1': {
                    id: 'm-1',
                    kind: 'tool-call',
                    localId: null,
                    createdAt: 1,
                    tool: {
                        id: 'tool-1',
                        name: 'SubAgentRun',
                        state: 'running',
                        input: { runId: 'run_12345678', label: 'Audit' },
                        result: { status: 'running', progress: 'phase 1' },
                    },
                    children: [],
                } as any,
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
                        latestReadyEventSeq: null,
                        latestReadyEventAt: null,
                        messagesVersion: 1,
                        lastAppliedAgentStateVersion: null,
                        isLoaded: true,
                    },
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionSubagentSourceMessages('s-1');
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initialRenderCount = renderCount;
            const initialMessages = hook.getCurrent();

            expect(initialMessages.map((message) => message.id)).toEqual(['m-1']);

            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessionMessages['s-1'];
                    if (!session) return state;
                    const existingMessage = session.messagesById['m-1'] as any;
                    const nextMessagesById = {
                        ...session.messagesById,
                        'm-1': {
                            ...existingMessage,
                            tool: {
                                ...existingMessage.tool,
                                result: { status: 'running', progress: 'phase 2' },
                            },
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
            });

            expect(hook.getCurrent()).toBe(initialMessages);
            expect(renderCount).toBe(initialRenderCount);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
