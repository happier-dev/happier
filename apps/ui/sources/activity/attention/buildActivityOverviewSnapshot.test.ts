import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Session } from '@/sync/domains/state/storageTypes';

import { buildActivityOverviewSnapshot } from './buildActivityOverviewSnapshot';

function createMetadata(
  overrides: Partial<NonNullable<Session['metadata']>> = {},
): NonNullable<Session['metadata']> {
  return {
    path: '/Users/tester/project',
    host: 'tester.local',
    homeDir: '/Users/tester',
    machineId: 'machine-1',
    ...overrides,
  };
}

describe('buildActivityOverviewSnapshot', () => {
  it('changes the fingerprint when content availability changes without changing generic copy', () => {
    const session = createSessionFixture({
      encryptionMode: 'e2ee',
      encryptedContentAvailability: undefined,
    });
    const unknown = buildActivityOverviewSnapshot({
      sessions: [session],
      nowMs: 1_000,
    });
    const unavailable = buildActivityOverviewSnapshot({
      sessions: [
        {
          ...session,
          encryptedContentAvailability: 'encrypted_content_unavailable',
        },
      ],
      nowMs: 1_000,
    });
    expect(unknown.candidates[0]?.title).toBe(unavailable.candidates[0]?.title);
    expect(unknown.fingerprint).not.toBe(unavailable.fingerprint);
  });

  it('omits the dormant queued-input aggregate', () => {
    expect(
      buildActivityOverviewSnapshot({ sessions: [] }).counts,
    ).not.toHaveProperty('queuedInput');
  });
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
      // A running Session is still counted as running, and still a candidate below. It just
      // is not something asking this Account for anything, so it stays out of attention.
      thinking: 1,
      permissionRequired: 1,
      actionRequired: 0,
      totalAttention: 2,
    });
    expect(snapshot.candidates.map((candidate) => candidate.sessionId)).toEqual(
      ['permission', 'thinking', 'unread'],
    );
  });

  it('orders equally urgent sessions by their last meaningful activity, so opening one does not move it', () => {
    // Viewing a session writes its read state, which stamps `updatedAt` with the moment it was
    // opened; nothing happened in the session, so its place in the list must not change.
    const older = createSessionFixture({
      id: 'older-work',
      createdAt: 1_000,
      meaningfulActivityAt: 2_000,
      updatedAt: 9_999,
      metadata: createMetadata({
        summary: { text: 'Older work', updatedAt: 1 },
      }),
    });
    const newer = createSessionFixture({
      id: 'newer-work',
      createdAt: 1_000,
      meaningfulActivityAt: 5_000,
      updatedAt: 5_000,
      metadata: createMetadata({
        summary: { text: 'Newer work', updatedAt: 1 },
      }),
    });
    const snapshot = buildActivityOverviewSnapshot({
      sessions: [older, newer],
      nowMs: 10_000,
    });
    expect(snapshot.candidates.map((candidate) => candidate.sessionId)).toEqual(
      ['newer-work', 'older-work'],
    );
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
      totalAttention: 1,
    });
  });
});
