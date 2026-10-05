import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useSessionPendingMessages, useSessionMessages, useSessionSubagentSourceMessages, useSessionTranscriptIds, useSessionVisibleReadSeq } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { Message } from "@happier-dev/session-core/messages";
import type { NormalizedMessage } from "@happier-dev/session-core/raw";
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

afterEach(() => {
    standardCleanup();
});

describe('useSessionMessages', () => {
    it('projects only the requested Pending target and ignores sibling row changes', async () => {
        const previousState = storage.getState();
        const main = { id: 'main', localId: 'main', text: 'main', createdAt: 1, updatedAt: 1, rawRecord: {} };
        const run = { ...main, id: 'run', localId: 'run', recipient: { kind: 'execution_run' as const, runId: 'run-a' } };
        try {
            storage.setState({ sessionPending: { 's-targets': { messages: [main, run], discarded: [], isLoaded: true } } });
            let renderCount = 0;
            const mainHook = await renderHook(() => {
                renderCount += 1;
                return useSessionPendingMessages('s-targets');
            });
            const runHook = await renderHook(() => useSessionPendingMessages('s-targets', run.recipient));
            expect(mainHook.getCurrent().messages).toEqual([main]);
            expect(runHook.getCurrent().messages).toEqual([run]);
            const before = renderCount;
            await act(async () => {
                storage.setState({ sessionPending: { 's-targets': { messages: [main, { ...run, text: 'updated' }], discarded: [], isLoaded: true } } });
            });
            expect(renderCount).toBe(before);
            expect(runHook.getCurrent().messages[0]?.text).toBe('updated');
            await mainHook.unmount();
            await runHook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps visible read seq stable when message content streams without seq changes', async () => {
        const previousState = storage.getState();
        try {
            const messagesById = {
                'm-1': { id: 'm-1', kind: 'user-text', localId: null, createdAt: 1, seq: 10, text: 'hi' } as any,
                'm-2': { id: 'm-2', kind: 'agent-text', localId: null, createdAt: 2, seq: 11, text: 'hello', isThinking: true } as any,
            };

            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    's-visible': {
                        messageIdsOldestFirst: ['m-1', 'm-2'],
                        messagesById,
                        messagesMap: messagesById,
                        reducerState: {} as any,
                        latestThinkingMessageId: 'm-2',
                        latestThinkingMessageActivityAtMs: 2,
                        messagesVersion: 1,
                        isLoaded: true,
                    },
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionVisibleReadSeq('s-visible', {
                    sessionSeq: 12,
                    latestTurnStatus: 'in_progress',
                });
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initialRenderCount = renderCount;

            expect(hook.getCurrent()).toBe(11);

            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessionMessages['s-visible'];
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
                            's-visible': {
                                ...session,
                                messagesById: nextMessagesById,
                                messagesMap: nextMessagesById,
                                messagesVersion: session.messagesVersion + 1,
                            },
                        },
                    };
                });
            });

            expect(hook.getCurrent()).toBe(11);
            expect(renderCount).toBe(initialRenderCount);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not rescan visible read seq when unrelated store state publishes', async () => {
        const previousState = storage.getState();
        try {
            const messagesById: Record<string, Message> = {
                'm-1': { id: 'm-1', kind: 'user-text', localId: null, createdAt: 1, seq: 10, text: 'hi' },
            };
            let transcriptOrderReads = 0;
            const transcript = {
                get messageIdsOldestFirst() {
                    transcriptOrderReads += 1;
                    return ['m-1'];
                },
                messagesById,
                messagesMap: messagesById,
                // Minimal selector fixture: reducer internals are irrelevant to visible-read derivation.
                reducerState: {} as any,
                latestThinkingMessageId: null,
                latestThinkingMessageActivityAtMs: null,
                messagesVersion: 1,
                isLoaded: true,
            };

            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    's-visible-cache': transcript,
                },
            }));

            const hook = await renderHook(() => useSessionVisibleReadSeq('s-visible-cache', {
                sessionSeq: 12,
                latestTurnStatus: 'in_progress',
            }), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe(10);
            const readsAfterInitialRender = transcriptOrderReads;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    isDataReady: state.isDataReady,
                }));
            });

            expect(hook.getCurrent()).toBe(10);
            expect(transcriptOrderReads).toBe(readsAfterInitialRender);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('returns null visible read seq for a loaded transcript with no readable activity', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    's-empty-visible': {
                        messageIdsOldestFirst: [],
                        messagesById: {},
                        messagesMap: {},
                        reducerState: {} as any,
                        latestThinkingMessageId: null,
                        latestThinkingMessageActivityAtMs: null,
                        messagesVersion: 1,
                        isLoaded: true,
                    },
                },
            }));

            const hook = await renderHook(() => useSessionVisibleReadSeq('s-empty-visible', {
                sessionSeq: 12,
                latestTurnStatus: 'in_progress',
            }), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBeNull();

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('uses published ready activity rather than raw terminal session seq for a loaded transcript', async () => {
        const previousState = storage.getState();
        const sessionId = 's-terminal-visible';
        try {
            storage.getState().applySessions([createSessionFixture({
                id: sessionId,
                seq: 12,
                latestTurnStatus: 'completed',
            })]);
            storage.getState().applyMessagesLoaded(sessionId);

            const hook = await renderHook(() => useSessionVisibleReadSeq(sessionId, {
                sessionSeq: storage.getState().sessions[sessionId].seq,
                latestTurnStatus: storage.getState().sessions[sessionId].latestTurnStatus,
            }), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            try {
                expect(hook.getCurrent()).toBe(0);

                await act(async () => {
                    storage.getState().applyMessages(sessionId, [{
                        id: 'ready-1',
                        seq: 11,
                        localId: null,
                        createdAt: 1_000,
                        isSidechain: false,
                        role: 'event',
                        content: { type: 'ready' },
                    }]);
                });

                expect(storage.getState().sessions[sessionId].seq).toBe(12);
                expect(hook.getCurrent()).toBe(11);
            } finally {
                await hook.unmount();
            }
        } finally {
            storage.setState(previousState);
        }
    });

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
                        messagesVersion: 1,
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

    it('updates transcript ids when the committed id order changes', async () => {
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
                        messageIdsOldestFirst: ['m-1'],
                        messagesById,
                        messagesMap: messagesById,
                        reducerState: {} as any,
                        latestThinkingMessageId: 'm-2',
                        latestThinkingMessageActivityAtMs: 2,
                        messagesVersion: 1,
                        isLoaded: true,
                    },
                },
            }));

            const hook = await renderHook(() => useSessionTranscriptIds('s-1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().ids).toEqual(['m-1']);

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
                                messageIdsOldestFirst: ['m-2', 'm-1'],
                                messagesVersion: session.messagesVersion + 1,
                            },
                        },
                    };
                });
            });

            expect(hook.getCurrent().ids).toEqual(['m-2', 'm-1']);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('updates transcript ids when committed ids are removed', async () => {
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
                        messagesVersion: 1,
                        isLoaded: true,
                    },
                },
            }));

            const hook = await renderHook(() => useSessionTranscriptIds('s-1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().ids).toEqual(['m-1', 'm-2']);

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
                                messageIdsOldestFirst: ['m-2'],
                                messagesVersion: session.messagesVersion + 1,
                            },
                        },
                    };
                });
            });

            expect(hook.getCurrent().ids).toEqual(['m-2']);

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
                        messagesVersion: 1,
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
                        messagesVersion: 2,
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
            await act(async () => {
                storage.setState(previousState);
            });
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
                        messagesVersion: 3,
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
            await act(async () => {
                storage.setState(previousState);
            });
        }
    });

    it('returns an empty array when ids and the committed message map are empty even if the transcript version is non-zero', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    's-1': {
                        messageIdsOldestFirst: [],
                        messagesById: {},
                        messagesMap: {},
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

            expect(hook.getCurrent().isLoaded).toBe(true);
            expect(hook.getCurrent().messages).toEqual([]);

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

describe('useSessionSubagentSourceMessages', () => {
    it('refreshes a mounted projection on authority replacement and subsequent empty replacement', async () => {
        const previousState = storage.getState();
        const sessionId = 'subagent-authority-replacement';
        const sourceRow = (id: string, runId: string): NormalizedMessage => ({
            id, seq: 1, localId: null, createdAt: 1_000, isSidechain: false,
            role: 'agent',
            content: [{ type: 'text', text: `Execution run ${runId} started`, uuid: id, parentUUID: null }],
        });
        try {
            storage.getState().applySessions([createSessionFixture({ id: sessionId })]);
            storage.getState().replaceSessionMessages(sessionId, [sourceRow('old-source', 'run_12345678')]);
            const hook = await renderHook(() => useSessionSubagentSourceMessages(sessionId));
            try {
                expect(hook.getCurrent()).toHaveLength(1);
                expect(hook.getCurrent()[0]).toMatchObject({ text: 'Execution run run_12345678 started' });
                await act(async () => {
                    storage.getState().replaceSessionMessages(sessionId, [sourceRow('new-source', 'run_87654321')]);
                });

                expect(Object.values(storage.getState().sessionMessages[sessionId].messagesById)[0])
                    .toMatchObject({ text: 'Execution run run_87654321 started' });
                expect(hook.getCurrent()).toHaveLength(1);
                expect(hook.getCurrent()[0]).toMatchObject({ text: 'Execution run run_87654321 started' });

                await act(async () => {
                    storage.getState().replaceSessionMessages(sessionId, []);
                });
                expect(hook.getCurrent()).toEqual([]);
            } finally {
                await hook.unmount();
            }
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not scan ordered messages when the subagent source version is unchanged', async () => {
        const previousState = storage.getState();
        try {
            const messagesById = {
                'm-1': {
                    id: 'm-1',
                    kind: 'agent-text',
                    localId: null,
                    createdAt: 1,
                    text: 'ordinary streamed text',
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
                        messagesVersion: 1,
                        subagentSourceVersion: 0,
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
                        messagesVersion: 1,
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

    // A teammate can enter the roster with no tool call ever naming it: launching one writes a
    // `happier` envelope onto the USER's own message, and the team derivation reads exactly that.
    // A projection that drops user turns therefore undercounts the roster for every surface that
    // derives from it, while a surface reading the whole transcript shows the member — which is the
    // two-surfaces-disagree defect a single roster owner exists to remove.
    it('keeps a user turn that carries a subagent envelope and drops an ordinary one', async () => {
        const previousState = storage.getState();
        try {
            const messagesById = {
                'm-launch': {
                    id: 'm-launch',
                    kind: 'user-text',
                    localId: null,
                    createdAt: 1,
                    text: 'spawn a reviewer',
                    meta: {
                        happier: {
                            kind: 'subagent_launch.v1',
                            payload: { kind: 'agent_team_member_create', teamId: 'team-1', memberId: 'alpha' },
                        },
                    },
                    children: [],
                } as any,
                'm-plain': {
                    id: 'm-plain',
                    kind: 'user-text',
                    localId: null,
                    createdAt: 2,
                    text: 'thanks',
                    children: [],
                } as any,
            };

            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    's-1': {
                        messageIdsOldestFirst: ['m-launch', 'm-plain'],
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

            const hook = await renderHook(() => useSessionSubagentSourceMessages('s-1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().map((message) => message.id)).toEqual(['m-launch']);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
