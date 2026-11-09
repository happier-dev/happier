import { describe, expect, it } from 'vitest';
import * as sessions from './sessionHumanPresenceV1.js';

describe('human presence V1 operation', () => {
  it('negotiates admitted edit identities without content or a lease deadline', () => {
    const pendingMessageEdits = [{ sessionId: 's', holdId: 'edit-device-1' }];
    expect(sessions.SessionHumanPresenceVisibleReplaceV1Schema.safeParse({
      v: 1, sessionIds: [], pendingMessageEdits,
    })).toMatchObject({ success: true, data: { pendingMessageEdits } });
    expect(sessions.SessionHumanPresenceVisibleReplaceResultV1Schema.safeParse({
      v: 1, ok: true, admittedSessionIds: [], admittedPendingMessageEdits: pendingMessageEdits,
    }).success).toBe(true);
    expect(sessions.SessionHumanPresenceSnapshotV1Schema.safeParse({
      v: 1, sessionId: 's', viewers: [], observedAt: 1, pendingMessageEditHoldIds: ['edit-device-1'],
    }).success).toBe(true);
    expect(sessions.SessionHumanPresenceVisibleReplaceV1Schema.safeParse({
      v: 1, sessionIds: [], pendingMessageEdits: [{ ...pendingMessageEdits[0], accountId: 'other' }],
    }).success).toBe(false);
  });
  it('normalizes the whole visible set and rejects malformed or authority-bearing extra input', () => {
    expect(sessions.SessionHumanPresenceVisibleReplaceV1Schema?.safeParse({ v: 1, sessionIds: [' b ', 'a', 'b'] }))
      .toMatchObject({ success: true, data: { v: 1, sessionIds: ['a', 'b'] } });
    for (const value of [
      { v: 1, sessionIds: ['a', ' '] },
      { v: 1, sessionIds: ['a'], accountId: 'someone-else' },
      { v: 2, sessionIds: ['a'] },
    ]) expect(sessions.SessionHumanPresenceVisibleReplaceV1Schema.safeParse(value).success).toBe(false);
  });

  it('admits independent Discussion locations while preserving the Session-only V1 shape', () => {
    expect(sessions.SessionHumanPresenceVisibleReplaceV1Schema.safeParse({
      v: 1,
      sessionIds: ['session-b', 'session-a'],
      locations: [
        { discussionId: 'discussion-2' },
        { discussionId: 'discussion-1' },
        { discussionId: 'discussion-1' },
      ],
    })).toMatchObject({
      success: true,
      data: {
        v: 1,
        sessionIds: ['session-a', 'session-b'],
        locations: [
          { discussionId: 'discussion-1' },
          { discussionId: 'discussion-2' },
        ],
      },
    });
    expect(sessions.SessionHumanPresenceVisibleReplaceV1Schema.safeParse({
      v: 1,
      sessionIds: ['session-a'],
    })).toMatchObject({ success: true, data: { v: 1, sessionIds: ['session-a'] } });
    expect(sessions.SessionHumanPresenceVisibleReplaceResultV1Schema.safeParse({
      v: 1,
      ok: true,
      admittedSessionIds: ['session-a'],
    }).success).toBe(true);
    expect(sessions.SessionHumanPresenceVisibleReplaceV1Schema.safeParse({
      v: 1, sessionIds: [], locations: [{ sessionId: 'session-a', discussionId: 'discussion-1' }],
    }).success).toBe(false);
    expect(sessions.SessionHumanPresenceVisibleReplaceResultV1Schema.safeParse({
      v: 1, ok: true, admittedSessionIds: [], admittedLocations: [{ discussionId: ' discussion-1 ' }],
    })).toMatchObject({ success: true, data: { admittedLocations: [{ discussionId: 'discussion-1' }] } });
    expect(sessions.SessionHumanPresenceTypingSetV1Schema.safeParse({
      v: 1,
      discussionId: 'discussion-1',
      typing: true,
    }).success).toBe(true);
    expect(sessions.SessionHumanPresenceSnapshotV1Schema.safeParse({
      v: 1,
      discussionId: 'discussion-1',
      observedAt: 1,
      viewers: [],
    }).success).toBe(true);
    expect(sessions.SessionHumanPresenceTypingSetV1Schema.safeParse({
      v: 1, sessionId: 'session-a', discussionId: 'discussion-1', typing: true,
    }).success).toBe(false);
    expect(sessions.SessionHumanPresenceSnapshotV1Schema.safeParse({
      v: 1, sessionId: 'session-a', discussionId: 'discussion-1', observedAt: 1, viewers: [],
    }).success).toBe(false);
  });

  it('accepts the complete finite rendered set without a Lane-specific count ceiling', () => {
    const ids = (count: number) => Array.from({ length: count }, (_value, index) => `session-${index}`);
    const beyondFormerCeiling = ids(17);
    expect(sessions.SessionHumanPresenceVisibleReplaceV1Schema.safeParse({
      v: 1,
      sessionIds: beyondFormerCeiling,
    })).toMatchObject({ success: true, data: { sessionIds: [...beyondFormerCeiling].sort() } });
    // Duplicates still collapse, so repeated rendering of the same Session does
    // not produce duplicate authorization work or room joins.
    expect(sessions.SessionHumanPresenceVisibleReplaceV1Schema.safeParse({
      v: 1, sessionIds: [...beyondFormerCeiling, ...beyondFormerCeiling],
    })).toMatchObject({ success: true, data: { sessionIds: [...beyondFormerCeiling].sort() } });
  });

  it('closes snapshots recursively and distinguishes unavailable from a current empty observation', () => {
    const snapshot = { v: 1, sessionId: 'session', observedAt: 1, viewers: [{
      account: { kind: 'account', accountId: 'person', firstName: 'Alice', lastName: null, username: null, avatarUrl: null },
      typing: false,
    }] };
    expect(sessions.SessionHumanPresenceSnapshotV1Schema?.safeParse(snapshot).success).toBe(true);
    expect(sessions.SessionHumanPresenceSnapshotV1Schema.safeParse({ ...snapshot, status: 'live' }).success).toBe(false);
    expect(sessions.SessionHumanPresenceSnapshotV1Schema.safeParse({ ...snapshot, viewers: [{
      ...snapshot.viewers[0], account: { ...snapshot.viewers[0].account, email: 'private@example.test' },
    }] }).success).toBe(false);
    expect(sessions.SessionHumanPresenceVisibleReplaceResultV1Schema.safeParse({ v: 1, ok: false, errorCode: 'UNAVAILABLE' }).success).toBe(true);
    expect(sessions.SessionHumanPresenceVisibleReplaceResultV1Schema.safeParse({ v: 1, ok: false, admittedSessionIds: [] }).success).toBe(false);
  });
});
