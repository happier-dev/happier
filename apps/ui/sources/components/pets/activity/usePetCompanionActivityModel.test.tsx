import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import type { Message } from '@/sync/domains/messages/messageTypes';
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
        messagesVersion: messages.length,
        isLoaded: true,
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

    it('does not map a failed tool call to failed session activity', async () => {
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
                sessionMessages: {
                    ...state.sessionMessages,
                    [session.id]: createSessionMessages([failedToolMessage]),
                },
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'review',
                reason: 'review',
                sessionId: session.id,
                trayItems: [
                    expect.objectContaining({
                        sessionId: session.id,
                        status: 'review',
                    }),
                ],
            });

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
            active: false,
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
                code: 'provider_status_error',
                source: 'provider_status_error',
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

    it('uses recent session thinking timestamps when the transcript is not hydrated in this window', async () => {
        vi.mocked(Date.now).mockReturnValue(12_000);
        const previousState = storage.getState();
        const session = createSessionFixture({
            id: 'recent-thinking-session',
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
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'running',
                reason: 'running',
                sessionId: session.id,
                trayItems: [
                    expect.objectContaining({
                        sessionId: session.id,
                        status: 'running',
                    }),
                ],
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
            active: false,
            seq: 2,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 2,
            pendingCount: 1,
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
            thinking: false,
            thinkingAt: 1_000,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
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
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            agentState: {
                controlledByUser: null,
                requests: {
                    request_1: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'git status' },
                        createdAt: 2_000,
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
