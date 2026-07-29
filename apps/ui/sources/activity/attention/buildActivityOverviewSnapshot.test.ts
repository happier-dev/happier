import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Session } from '@/sync/domains/state/storageTypes';

import { buildActivityOverviewSnapshot } from './buildActivityOverviewSnapshot';

function createMetadata(overrides: Partial<NonNullable<Session['metadata']>> = {}): NonNullable<Session['metadata']> {
    return {
        path: '/Users/tester/project',
        host: 'tester.local',
        homeDir: '/Users/tester',
        machineId: 'machine-1',
        ...overrides,
    };
}

describe('buildActivityOverviewSnapshot', () => {
    it('sorts the highest-urgency sessions first and counts overview buckets', () => {
        const snapshot = buildActivityOverviewSnapshot({
            sessions: [
                createSessionFixture({
                    id: 'unread',
                    seq: 5,
                    latestReadyEventSeq: 5,
                    lastViewedSessionSeq: 2,
                    metadata: createMetadata({
                        summary: { text: 'Unread work', updatedAt: 1 },
                    }),
                }),
                createSessionFixture({
                    id: 'thinking',
                    active: true,
                    presence: 'online',
                    thinking: true,
                    thinkingAt: 9_900,
                    lastViewedSessionSeq: 1,
                    metadata: createMetadata({
                        summary: { text: 'Thinking work', updatedAt: 1 },
                    }),
                }),
                createSessionFixture({
                    id: 'permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 9_900,
                    lastViewedSessionSeq: 1,
                    metadata: createMetadata({
                        summary: { text: 'Permission work', updatedAt: 1 },
                    }),
                }),
            ],
            nowMs: 10_000,
        });

        expect(snapshot.counts).toMatchObject({
            unread: 1,
            thinking: 1,
            permissionRequired: 1,
            actionRequired: 0,
            queuedInput: 0,
            totalAttention: 3,
        });
        expect(snapshot.candidates.map((candidate) => candidate.sessionId)).toEqual([
            'permission',
            'thinking',
            'unread',
        ]);
    });

    it('counts a session once in totalAttention even when multiple attention reasons are active', () => {
        const snapshot = buildActivityOverviewSnapshot({
            sessions: [
                createSessionFixture({
                    id: 'stacked',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 9_900,
                    pendingCount: 3,
                    seq: 5,
                    latestReadyEventSeq: 5,
                    lastViewedSessionSeq: 1,
                    metadata: createMetadata({
                        summary: { text: 'Stacked work', updatedAt: 1 },
                    }),
                }),
            ],
            nowMs: 10_000,
        });

        expect(snapshot.counts).toMatchObject({
            unread: 1,
            permissionRequired: 1,
            queuedInput: 0,
            totalAttention: 1,
        });
    });
});
