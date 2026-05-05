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
