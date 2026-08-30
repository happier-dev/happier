import { describe, expect, it } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import { areStoredSessionsEqual } from './areStoredSessionsEqual';

function session(overrides: Partial<Session> & {
    latestTurnId?: unknown;
    latestTurnStatus?: unknown;
    lastRuntimeIssue?: unknown;
    pendingRequestObservedAt?: unknown;
    rollbackEligibleTurnStarts?: unknown;
    sessionTurns?: unknown;
} = {}): Session {
    return {
        id: 's1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    } as Session;
}

describe('areStoredSessionsEqual', () => {
    it('detects latest turn id changes', () => {
        expect(areStoredSessionsEqual(
            session({ latestTurnId: 'turn-1' }),
            session({ latestTurnId: 'turn-2' }),
        )).toBe(false);
    });

    it('detects primary turn status changes', () => {
        expect(areStoredSessionsEqual(
            session({ latestTurnStatus: 'in_progress' }),
            session({ latestTurnStatus: 'failed' }),
        )).toBe(false);
    });

    it('detects runtime issue projection changes', () => {
        expect(areStoredSessionsEqual(
            session({
                latestTurnStatus: 'failed',
                lastRuntimeIssue: {
                    v: 1,
                    scope: 'primary_session',
                    status: 'failed',
                    code: 'auth_error',
                    source: 'auth_error',
                    occurredAt: 1,
                },
            }),
            session({
                latestTurnStatus: 'failed',
                lastRuntimeIssue: null,
            }),
        )).toBe(false);
    });

    it('detects pending request observation changes', () => {
        expect(areStoredSessionsEqual(
            session({ pendingRequestObservedAt: 100 }),
            session({ pendingRequestObservedAt: 200 }),
        )).toBe(false);
    });

    it('detects resume lifecycle marker changes', () => {
        expect(areStoredSessionsEqual(
            session({ resumingAt: null }),
            session({ resumingAt: 200 }),
        )).toBe(false);
    });

    it('detects rollback-eligible turn start changes', () => {
        expect(areStoredSessionsEqual(
            session({ rollbackEligibleTurnStarts: [1] }),
            session({ rollbackEligibleTurnStarts: [1, 3] }),
        )).toBe(false);
    });

    it('detects structured session turn projection changes when legacy rollback starts are unchanged', () => {
        const sessionTurns = {
            v: 1 as const,
            sessionId: 's1',
            latestTurnId: 'turn-1',
            updatedAt: 10,
            turns: [
                {
                    turnId: 'turn-1',
                    status: 'completed' as const,
                    startedAt: 1,
                    updatedAt: 10,
                    terminalAt: 10,
                    transcriptAnchors: {
                        startUserMessageSeq: 1,
                        userMessageSeqs: [1],
                        startSeqInclusive: 1,
                        endSeqInclusive: 2,
                    },
                    rollback: { state: 'eligible' as const, updatedAt: 10 },
                },
            ],
        };

        expect(areStoredSessionsEqual(
            session({ rollbackEligibleTurnStarts: [1], sessionTurns }),
            session({
                rollbackEligibleTurnStarts: [1],
                sessionTurns: {
                    ...sessionTurns,
                    updatedAt: 20,
                    turns: sessionTurns.turns.map((turn) => ({
                        ...turn,
                        updatedAt: 20,
                        rollback: { state: 'not_eligible' as const, reason: 'not_latest_turn', updatedAt: 20 },
                    })),
                },
            }),
        )).toBe(false);
    });

    it('detects runtime activity projection changes so higher revisions are retained', () => {
        expect(areStoredSessionsEqual(
            session({
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: 100,
            }),
            session({
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: 150,
            }),
        )).toBe(false);
    });

    it('detects runtime activity start and clear transitions', () => {
        expect(areStoredSessionsEqual(
            session({
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
            }),
            session({
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: 100,
            }),
        )).toBe(false);
    });

    it('detects explicit v2 state and revision changes without lease timestamps', () => {
        expect(areStoredSessionsEqual(
            session({
                runtimeActivityState: 'unknown',
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 8,
            }),
            session({
                runtimeActivityState: 'idle',
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 9,
            }),
        )).toBe(false);
    });
});
