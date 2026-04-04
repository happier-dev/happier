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

    it('treats queued user input as attention and preserves the shortened path subtitle', () => {
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
            attentionState: 'pending',
            hasAttention: true,
            reasons: {
                hasQueuedUserInput: true,
            },
            subtitle: '~/project/packages/app',
        });
    });
});
