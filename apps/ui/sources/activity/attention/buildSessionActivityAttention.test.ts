import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Session } from '@/sync/domains/state/storageTypes';

import { buildSessionActivityAttention } from './buildSessionActivityAttention';

function createMetadata(overrides: Partial<NonNullable<Session['metadata']>> = {}): NonNullable<Session['metadata']> {
    return {
        path: '/Users/tester/project',
        host: 'tester.local',
        homeDir: '/Users/tester',
        machineId: 'machine-1',
        ...overrides,
    };
}

describe('buildSessionActivityAttention', () => {
    it('prioritizes permission-required sessions above unread sessions', () => {
        const attention = buildSessionActivityAttention({
            session: createSessionFixture({
                id: 'session-permission',
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                agentState: {
                    controlledByUser: null,
                    requests: {
                        permission_1: {
                            tool: 'Bash',
                            kind: 'permission',
                            arguments: { command: 'deploy' },
                            createdAt: Date.now(),
                        },
                    },
                },
                seq: 3,
                lastViewedSessionSeq: 3,
                metadata: createMetadata({
                    summary: { text: 'Review deploy', updatedAt: 1 },
                }),
            }),
        });

        expect(attention).toMatchObject({
            sessionId: 'session-permission',
            title: 'Review deploy',
            attentionState: 'permission_required',
            hasAttention: true,
            reasons: {
                hasPendingPermissionRequests: true,
                hasPendingUserActionRequests: false,
            },
        });
        expect(attention.priority).toBeGreaterThan(0);
    });

    it('does not surface inactive permission counts as permission-required attention', () => {
        const attention = buildSessionActivityAttention({
            session: createSessionFixture({
                id: 'session-inactive',
                active: false,
                presence: 'online',
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
                seq: 1,
                lastViewedSessionSeq: 1,
                pendingCount: 0,
                metadata: createMetadata(),
            }),
        });

        expect(attention).toMatchObject({
            sessionId: 'session-inactive',
            attentionState: 'quiet',
            hasAttention: false,
            reasons: {
                hasPendingPermissionRequests: false,
                hasPendingUserActionRequests: false,
            },
        });
        expect(attention.priority).toBe(0);
    });

    it('does not treat queued user input as attention', () => {
        const attention = buildSessionActivityAttention({
            session: createSessionFixture({
                id: 'session-pending',
                active: true,
                presence: 'online',
                pendingCount: 2,
                lastViewedSessionSeq: 1,
                metadata: createMetadata({
                    path: '/Users/tester/project/packages/app',
                }),
            }),
        });

        expect(attention).toMatchObject({
            sessionId: 'session-pending',
            attentionState: 'quiet',
            hasAttention: false,
            reasons: {
                hasQueuedUserInput: true,
            },
            subtitle: '~/project/packages/app',
        });
    });

    it('treats fresh optimistic queued user input as working attention', () => {
        const attention = buildSessionActivityAttention({
            session: createSessionFixture({
                id: 'session-pending-working',
                active: true,
                presence: 'online',
                thinking: false,
                thinkingAt: 1,
                pendingCount: 1,
                optimisticThinkingAt: 1_000,
                metadata: createMetadata(),
            }),
            nowMs: 1_100,
        });

        expect(attention).toMatchObject({
            sessionId: 'session-pending-working',
            attentionState: 'thinking',
            hasAttention: true,
            reasons: {
                hasQueuedUserInput: true,
                isThinking: true,
            },
        });
    });

    it('surfaces a recent explicit turn completion as ready attention', () => {
        const attention = buildSessionActivityAttention({
            session: Object.assign(createSessionFixture({
                id: 'session-turn-complete',
                active: false,
                presence: 900,
                seq: 5,
                lastViewedSessionSeq: 5,
                metadata: createMetadata(),
            }), {
                lastTurnCompletedAt: 980,
            }),
            nowMs: 1_000,
        });

        expect(attention).toMatchObject({
            sessionId: 'session-turn-complete',
            attentionState: 'pending',
            hasAttention: true,
            lastTurnCompletedAt: 980,
            reasons: {
                hasQueuedUserInput: false,
                hasPendingPermissionRequests: false,
                hasPendingUserActionRequests: false,
                isThinking: false,
            },
        });
    });

    it('keeps stale explicit turn completion timestamps without surfacing attention', () => {
        const attention = buildSessionActivityAttention({
            session: Object.assign(createSessionFixture({
                id: 'session-stale-turn-complete',
                active: false,
                presence: 1,
                seq: 5,
                lastViewedSessionSeq: 5,
                metadata: createMetadata(),
            }), {
                lastTurnCompletedAt: 1_000,
            }),
            nowMs: 31_001,
        });

        expect(attention).toMatchObject({
            sessionId: 'session-stale-turn-complete',
            attentionState: 'quiet',
            hasAttention: false,
            lastTurnCompletedAt: 1_000,
        });
    });

    it('surfaces failed primary-session runtime issues through activity attention', () => {
        const attention = buildSessionActivityAttention({
            session: Object.assign(createSessionFixture({
                id: 'session-runtime-failed',
                active: false,
                presence: 'online',
                seq: 5,
                lastViewedSessionSeq: 5,
                metadata: createMetadata(),
            }), {
                latestTurnStatus: 'failed',
                lastRuntimeIssue: {
                    v: 1,
                    scope: 'primary_session',
                    status: 'failed',
                    code: 'agent_status_error',
                    source: 'agent_status_error',
                    occurredAt: 100,
                    sanitizedPreview: 'Provider reported an error',
                },
            }),
        });

        expect(attention).toMatchObject({
            sessionId: 'session-runtime-failed',
            attentionState: 'failed',
            hasAttention: true,
        });
        expect(attention.priority).toBeGreaterThan(0);
    });

    it('keeps same-id pending requests fresh when completed request arguments differ', () => {
        const attention = buildSessionActivityAttention({
            session: createSessionFixture({
                id: 'session-permission-retry',
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                pendingRequestObservedAt: null,
                agentState: {
                    controlledByUser: null,
                    requests: {
                        permission_retry: {
                            tool: 'Bash',
                            kind: 'permission',
                            arguments: { command: 'git status' },
                            createdAt: 12_345,
                        },
                    },
                    completedRequests: {
                        permission_retry: {
                            tool: 'Bash',
                            kind: 'permission',
                            arguments: { command: 'git diff' },
                            completedAt: 12_500,
                            status: 'approved',
                        },
                    },
                },
                metadata: createMetadata({
                    summary: { text: 'Retry permission', updatedAt: 1 },
                }),
            }),
            nowMs: 12_600,
        });

        expect(attention).toMatchObject({
            sessionId: 'session-permission-retry',
            attentionState: 'permission_required',
            hasAttention: true,
            reasons: {
                hasPendingPermissionRequests: true,
            },
        });
    });
});
