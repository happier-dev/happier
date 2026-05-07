import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit';

import { buildPetCompanionActivityState } from './buildPetCompanionActivityState';

describe('buildPetCompanionActivityState', () => {
    it('prioritizes waiting above failed, review, and running activity', () => {
        const session = createSessionFixture({
            id: 'waiting-session',
            active: true,
            thinking: true,
            pendingCount: 1,
        });

        expect(buildPetCompanionActivityState({
            sessions: [session],
            selectedSessionId: session.id,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: true,
                    hasUnreadMessages: true,
                    latestThinkingActivityAtMs: 5_000,
                    latestMeaningfulActivityAtMs: 5_000,
                    pendingMessageCount: 1,
                },
            },
        })).toMatchObject({
            state: 'waiting',
            reason: 'waiting',
            sessionId: session.id,
        });
    });

    it('expires stale running activity from the tray model', () => {
        const session = createSessionFixture({
            id: 'stale-running-session',
            active: true,
            thinking: false,
            updatedAt: 0,
        });
        const input = {
            sessions: [session],
            selectedSessionId: session.id,
            nowMs: 180_001,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: false,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: 0,
                    latestMeaningfulActivityAtMs: 0,
                    pendingMessageCount: 0,
                },
            },
        };

        expect(buildPetCompanionActivityState(input)).toMatchObject({
            state: 'idle',
            reason: 'idle',
            sessionId: session.id,
            trayItems: [],
        });
    });

    it('maps recent session thinking timestamps to running activity without transcript signals', () => {
        const session = createSessionFixture({
            id: 'recent-thinking-session',
            active: true,
            thinking: false,
            thinkingAt: 10_000,
            updatedAt: 10_000,
            activeAt: 10_000,
        });

        expect(buildPetCompanionActivityState({
            sessions: [session],
            selectedSessionId: session.id,
            nowMs: 10_001,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: false,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: null,
                    latestMeaningfulActivityAtMs: null,
                    pendingMessageCount: 0,
                },
            },
        })).toMatchObject({
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
    });

    it('maps optimistic thinking and active thinking grace to running activity', () => {
        const optimisticSession = createSessionFixture({
            id: 'optimistic-thinking-session',
            active: true,
            thinking: false,
            optimisticThinkingAt: 20_000,
            updatedAt: 20_000,
            activeAt: 20_000,
        });
        const graceSession = createSessionFixture({
            id: 'thinking-grace-session',
            active: false,
            thinking: false,
            thinkingGraceUntil: 35_000,
            updatedAt: 30_000,
            activeAt: 30_000,
        });

        const model = buildPetCompanionActivityState({
            sessions: [optimisticSession, graceSession],
            selectedSessionId: optimisticSession.id,
            nowMs: 30_001,
            signalsBySessionId: {
                [optimisticSession.id]: {
                    hasFailure: false,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: null,
                    latestMeaningfulActivityAtMs: null,
                    pendingMessageCount: 0,
                },
                [graceSession.id]: {
                    hasFailure: false,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: null,
                    latestMeaningfulActivityAtMs: null,
                    pendingMessageCount: 0,
                },
            },
        });

        expect(model.trayItems.map((item) => item.sessionId).sort()).toEqual([
            graceSession.id,
            optimisticSession.id,
        ].sort());
        expect(model.trayItems.every((item) => item.status === 'running')).toBe(true);
    });

    it('prioritizes failed session state over review and running activity', () => {
        const session = createSessionFixture({
            id: 'failed-session',
            active: true,
            thinking: true,
        });

        expect(buildPetCompanionActivityState({
            sessions: [session],
            selectedSessionId: session.id,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: true,
                    hasUnreadMessages: true,
                    latestThinkingActivityAtMs: 9_000,
                    latestMeaningfulActivityAtMs: 9_000,
                    pendingMessageCount: 0,
                },
            },
        })).toMatchObject({
            state: 'failed',
            reason: 'failed',
            sessionId: session.id,
        });
    });

    it('maps pending permission attention to waiting', () => {
        const session = createSessionFixture({
            id: 'permission-session',
            active: true,
            pendingPermissionRequestCount: 1,
        });

        expect(buildPetCompanionActivityState({
            sessions: [session],
            selectedSessionId: session.id,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: false,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: null,
                    latestMeaningfulActivityAtMs: 1_000,
                    pendingMessageCount: 0,
                },
            },
        })).toMatchObject({
            state: 'waiting',
            reason: 'waiting',
            sessionId: session.id,
        });
    });

    it('maps unread completion attention to review', () => {
        const session = createSessionFixture({
            id: 'review-session',
            active: false,
            thinking: false,
        });

        expect(buildPetCompanionActivityState({
            sessions: [session],
            selectedSessionId: session.id,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: false,
                    hasUnreadMessages: true,
                    latestThinkingActivityAtMs: null,
                    latestMeaningfulActivityAtMs: 2_000,
                    pendingMessageCount: 0,
                },
            },
        })).toMatchObject({
            state: 'review',
            reason: 'review',
            sessionId: session.id,
        });
    });

    it('maps live thinking activity to running', () => {
        const session = createSessionFixture({
            id: 'running-session',
            active: true,
            thinking: true,
            thinkingAt: 3_000,
        });

        expect(buildPetCompanionActivityState({
            sessions: [session],
            selectedSessionId: session.id,
            signalsBySessionId: {
                [session.id]: {
                    hasFailure: false,
                    hasUnreadMessages: false,
                    latestThinkingActivityAtMs: 3_000,
                    latestMeaningfulActivityAtMs: 3_000,
                    pendingMessageCount: 0,
                },
            },
        })).toMatchObject({
            state: 'running',
            reason: 'running',
            sessionId: session.id,
        });
    });
});
