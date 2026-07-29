import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { storage } from '@/sync/domains/state/storageStore';
import { createReducer } from '@/sync/reducer/reducer';
import type { SessionMessages } from '@/sync/store/domains/messages';

import { usePetCompanionActivityModel } from './usePetCompanionActivityModel';
import { PET_COMPANION_ACTIVITY_EXPIRY_MS } from './petCompanionActivityConstants';

function createSessionMessages(messages: readonly Message[]): SessionMessages {
    const messagesById: Record<string, Message> = {};
    const messageIdsOldestFirst: string[] = [];
    for (const message of messages) {
        messagesById[message.id] = message;
        messageIdsOldestFirst.push(message.id);
    }

    return {
        messageIdsOldestFirst,
        messagesById,
        messagesMap: messagesById,
        reducerState: createReducer(),
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        messagesVersion: messages.length,
        isLoaded: true,
    };
}

function buildSessionListProjection(sessions: readonly ReturnType<typeof createSessionFixture>[]) {
    return {
        sessionListRenderables: Object.fromEntries(
            sessions.map((session) => [session.id, buildSessionListRenderableFromSession(session)]),
        ),
        sessionListIndexByServerId: {
            'server-a': sessions.map((session) => ({
                type: 'session' as const,
                sessionId: session.id,
                serverId: 'server-a',
                serverName: 'Server A',
            })),
        },
    };
}

describe('usePetCompanionActivityModel', () => {
    beforeEach(() => {
        vi.spyOn(Date, 'now').mockReturnValue(4_000);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        standardCleanup();
    });

    it('does not map a failed tool call to failed or waiting session activity', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'failed-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 0,
            thinking: false,
            thinkingAt: 0,
        });
        const failedToolMessage: Message = {
            kind: 'tool-call',
            id: 'tool-failed',
            localId: null,
            createdAt: 2_000,
            tool: {
                id: 'tool-1',
                name: 'Bash',
                state: 'error',
                input: { command: 'exit 1' },
                createdAt: 2_000,
                startedAt: 2_000,
                completedAt: 2_100,
                description: null,
                result: { error: 'Command failed' },
            },
            children: [],
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
                sessionMessages: {
                    ...state.sessionMessages,
                    [session.id]: createSessionMessages([failedToolMessage]),
                },
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'idle',
                reason: 'idle',
                sessionId: session.id,
                trayItems: [],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity when unrelated storage state changes', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'stable-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeUnrelatedUpdate = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    settings: state.settings,
                }));
            });

            expect(renderCount).toBe(renderCountBeforeUnrelatedUpdate);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not recompute activity when a hidden system session changes', async () => {
        const previousState = storage.getState();
        const visibleSession = createSessionFixture({
            id: 'visible-waiting-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: 3_000,
            agentState: {
                controlledByUser: null,
                requests: {
                    action_1: {
                        tool: 'Read',
                        kind: 'user_action',
                        arguments: { path: '/tmp/visible-waiting-session' },
                        createdAt: 3_000,
                    },
                },
            },
            thinking: false,
            thinkingAt: 0,
        });
        const hiddenSession = createSessionFixture({
            id: 'hidden-system-update-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            pendingCount: 0,
            thinking: false,
            thinkingAt: 0,
            metadata: {
                path: '/tmp/hidden-system-update-session',
                host: 'test-host',
                summary: { text: 'Hidden system session', updatedAt: 2_000 },
                systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
            },
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {
                    [visibleSession.id]: visibleSession,
                    [hiddenSession.id]: hiddenSession,
                },
                ...buildSessionListProjection([visibleSession, hiddenSession]),
                sessionMessages: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(hook.getCurrent()).toMatchObject({
                state: 'waiting',
                reason: 'waiting',
                sessionId: visibleSession.id,
            });
            const renderCountBeforeHiddenUpdate = renderCount;
            const hiddenSessionMetadata = hiddenSession.metadata;
            if (!hiddenSessionMetadata) {
                throw new Error('Expected hidden session metadata fixture');
            }
            const updatedHiddenSession = {
                ...hiddenSession,
                updatedAt: 9_000,
                pendingCount: 2,
                metadata: {
                    ...hiddenSessionMetadata,
                    summary: { text: 'Hidden system session changed', updatedAt: 9_000 },
                },
            };

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        [visibleSession.id]: visibleSession,
                        [updatedHiddenSession.id]: updatedHiddenSession,
                    },
                    ...buildSessionListProjection([visibleSession, updatedHiddenSession]),
                }));
            });

            expect(renderCount).toBe(renderCountBeforeHiddenUpdate);
            expect(hook.getCurrent().sessionId).toBe(visibleSession.id);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('recomputes fallback session activity for meaningful activity without surfacing runtime attention', async () => {
        vi.mocked(Date.now).mockReturnValue(130_000);
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'fallback-meaningful-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_000,
            meaningfulActivityAt: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
                sessionMessages: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(hook.getCurrent()).toMatchObject({
                state: 'idle',
                reason: 'idle',
                sessionId: session.id,
            });
            const renderCountBeforeBookkeepingUpdate = renderCount;
            const bookkeepingSession = { ...session, updatedAt: 3_000 };

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: { [bookkeepingSession.id]: bookkeepingSession },
                    ...buildSessionListProjection([bookkeepingSession]),
                }));
            });

            expect(renderCount).toBe(renderCountBeforeBookkeepingUpdate);

            const renderCountBeforeMeaningfulActivityUpdate = renderCount;
            const meaningfulSession = {
                ...bookkeepingSession,
                meaningfulActivityAt: 129_000,
            };

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: { [meaningfulSession.id]: meaningfulSession },
                    ...buildSessionListProjection([meaningfulSession]),
                }));
            });

            expect(renderCount).toBeGreaterThan(renderCountBeforeMeaningfulActivityUpdate);
            expect(hook.getCurrent()).toMatchObject({
                state: 'idle',
                reason: 'idle',
                sessionId: session.id,
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('recomputes renderable-only activity for meaningful activity without surfacing runtime attention', async () => {
        vi.mocked(Date.now).mockReturnValue(130_000);
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'renderable-meaningful-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_000,
            meaningfulActivityAt: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {},
                sessionListRenderables: {
                    [session.id]: buildSessionListRenderableFromSession(session),
                },
                sessionListIndexByServerId: {
                    'server-a': [
                        { type: 'session', sessionId: session.id, serverId: 'server-a', serverName: 'Server A' },
                    ],
                },
                sessionMessages: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(hook.getCurrent()).toMatchObject({
                state: 'idle',
                reason: 'idle',
                sessionId: session.id,
            });
            const renderCountBeforeBookkeepingUpdate = renderCount;
            const bookkeepingSession = { ...session, updatedAt: 3_000 };

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRenderables: {
                        [bookkeepingSession.id]: buildSessionListRenderableFromSession(bookkeepingSession),
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeBookkeepingUpdate);

            const renderCountBeforeMeaningfulActivityUpdate = renderCount;
            const meaningfulSession = {
                ...bookkeepingSession,
                meaningfulActivityAt: 129_000,
            };

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRenderables: {
                        [meaningfulSession.id]: buildSessionListRenderableFromSession(meaningfulSession),
                    },
                }));
            });

            expect(renderCount).toBeGreaterThan(renderCountBeforeMeaningfulActivityUpdate);
            expect(hook.getCurrent()).toMatchObject({
                state: 'idle',
                reason: 'idle',
                sessionId: session.id,
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('ignores transcript updates outside the companion session scope', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'scoped-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
        });
        const unrelatedMessage: Message = {
            kind: 'agent-text',
            id: 'unrelated-message',
            localId: null,
            createdAt: 3_000,
            text: 'Background session streamed a token',
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
                sessionMessages: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionActivityModel();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeUnrelatedTranscriptUpdate = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        'unrelated-session': createSessionMessages([unrelatedMessage]),
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeUnrelatedTranscriptUpdate);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('aggregates runtime failure signals across non-selected sessions', async () => {
        const previousState = storage.getState();
        const activeSession = createSessionFixture({
            id: 'active-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
        });
        const failedSession = {
            ...createSessionFixture({
            id: 'failed-session',
            active: true,
            seq: 2,
            createdAt: 1_500,
            updatedAt: 3_000,
            activeAt: 3_000,
            lastViewedSessionSeq: 2,
            thinking: false,
            thinkingAt: 0,
            }),
            latestTurnStatus: 'failed',
            lastRuntimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'agent_status_error',
                source: 'agent_status_error',
                occurredAt: 3_000,
            },
        } as const;
        const failedToolMessage: Message = {
            kind: 'tool-call',
            id: 'tool-failed',
            localId: null,
            createdAt: 3_000,
            tool: {
                id: 'tool-1',
                name: 'Bash',
                state: 'error',
                input: { command: 'exit 1' },
                createdAt: 3_000,
                startedAt: 3_000,
                completedAt: 3_100,
                description: null,
                result: { error: 'Command failed' },
            },
            children: [],
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {
                    [activeSession.id]: activeSession,
                    [failedSession.id]: failedSession,
                },
                ...buildSessionListProjection([activeSession, failedSession]),
                sessionMessages: {
                    ...state.sessionMessages,
                    [activeSession.id]: createSessionMessages([]),
                    [failedSession.id]: createSessionMessages([failedToolMessage]),
                },
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'failed',
                reason: 'failed',
                sessionId: failedSession.id,
            });
            expect(hook.getCurrent().trayItems.map((item) => item.sessionId)).toContain(failedSession.id);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not treat a read online row with historical thinkingAt as running activity', async () => {
        vi.mocked(Date.now).mockReturnValue(12_000);
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'historical-thinking-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 10_000,
            activeAt: 10_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 10_000,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'idle',
                reason: 'idle',
                sessionId: session.id,
                trayItems: [],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not surface old unread sessions as pet waiting activity without projected runtime attention', async () => {
        vi.mocked(Date.now).mockReturnValue(900_000_000);
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'old-unread-session',
            active: true,
            seq: 5,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 4,
            pendingCount: 0,
            thinking: false,
            thinkingAt: 0,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'idle',
                reason: 'idle',
                sessionId: session.id,
                trayItems: [],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not use unhydrated unread rows as pet waiting activity without projected runtime attention', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'renderable-only-unread',
            active: true,
            seq: 4,
            createdAt: 1_000,
            updatedAt: 3_000,
            activeAt: 3_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 3_000,
            metadata: {
                path: '/tmp/renderable-only-unread',
                host: 'test-host',
                summary: { text: 'Renderable unread session', updatedAt: 3_000 },
            },
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {},
                sessionListRenderables: {
                    [session.id]: buildSessionListRenderableFromSession(session),
                },
                sessionListIndexByServerId: {
                    'server-a': [
                        { type: 'session', sessionId: session.id, serverId: 'server-a', serverName: 'Server A' },
                    ],
                },
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'idle',
                reason: 'idle',
                sessionId: session.id,
                trayItems: [],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('excludes hidden system sessions from companion activity', async () => {
        const previousState = storage.getState();
        const voiceSession = createSessionFixture({
            id: 'voice-system-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 3_000,
            activeAt: 3_000,
            lastViewedSessionSeq: 1,
            pendingCount: 1,
            thinking: false,
            thinkingAt: 0,
            metadata: {
                path: '/tmp/voice-system-session',
                host: 'test-host',
                summary: { text: 'Voice conversation (system)', updatedAt: 3_000 },
                systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
            },
        });
        const visibleSession = createSessionFixture({
            id: 'visible-session',
            active: true,
            seq: 2,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 2,
            pendingCount: 0,
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: Date.now(),
            agentState: {
                controlledByUser: null,
                requests: {
                    action_1: {
                        tool: 'Read',
                        kind: 'user_action',
                        arguments: { path: '/tmp/visible-session' },
                        createdAt: Date.now(),
                    },
                },
            },
            thinking: false,
            thinkingAt: 0,
            metadata: {
                path: '/tmp/visible-session',
                host: 'test-host',
                summary: { text: 'Visible session', updatedAt: 2_000 },
            },
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {
                    [voiceSession.id]: voiceSession,
                    [visibleSession.id]: visibleSession,
                },
                ...buildSessionListProjection([voiceSession, visibleSession]),
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'waiting',
                reason: 'waiting',
                sessionId: visibleSession.id,
                trayItems: [
                    expect.objectContaining({
                        sessionId: visibleSession.id,
                    }),
                ],
            });
            expect(hook.getCurrent().trayItems.map((item) => item.sessionId)).not.toContain(voiceSession.id);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('expires stale activity when no store update happens at the expiry boundary', async () => {
        vi.restoreAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(4_000);
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'recent-thinking-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 1_000,
            activeAt: 1_000,
            lastViewedSessionSeq: 1,
            thinking: true,
            thinkingAt: 1_000,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'running',
                reason: 'running',
                sessionId: session.id,
            });

            await act(async () => {
                vi.setSystemTime(1_000 + PET_COMPANION_ACTIVITY_EXPIRY_MS.running + 1);
                await vi.advanceTimersByTimeAsync(PET_COMPANION_ACTIVITY_EXPIRY_MS.running);
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'idle',
                reason: 'idle',
                sessionId: session.id,
                trayItems: [],
            });

            await hook.unmount();
        } finally {
            vi.useRealTimers();
            storage.setState(previousState, true);
        }
    });

    it('does not use queued pending input as waiting activity', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'stale-queued-session',
            active: true,
            seq: 2,
            createdAt: 1_000,
            updatedAt: 3_000,
            activeAt: 3_000,
            lastViewedSessionSeq: 2,
            pendingCount: 1,
            thinking: false,
            thinkingAt: 0,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'idle',
                reason: 'idle',
                sessionId: session.id,
                trayItems: [],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('updates running activity when an online working session goes offline', async () => {
        vi.mocked(Date.now).mockReturnValue(4_000);
        const previousState = storage.getState();
        const onlineSession = createSessionFixture({
            id: 'presence-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 3_000,
            activeAt: 3_000,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 3_000,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [onlineSession.id]: onlineSession },
                ...buildSessionListProjection([onlineSession]),
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'running',
                reason: 'running',
                sessionId: onlineSession.id,
            });

            const offlineSession = {
                ...onlineSession,
                presence: 3_500,
            };
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: { [offlineSession.id]: offlineSession },
                    ...buildSessionListProjection([offlineSession]),
                }));
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'idle',
                reason: 'idle',
                sessionId: onlineSession.id,
                trayItems: [],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('uses unhydrated agent-state requests as waiting activity', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'agent-state-request-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            pendingCount: 0,
            agentState: {
                controlledByUser: null,
                requests: {
                    request_1: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'git status' },
                        createdAt: Date.now(),
                    },
                },
            },
            agentStateVersion: 2,
            thinking: false,
            thinkingAt: 0,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'waiting',
                reason: 'waiting',
                sessionId: session.id,
                trayItems: [
                    expect.objectContaining({
                        sessionId: session.id,
                        status: 'waiting',
                    }),
                ],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });
});
