import { describe, expect, it } from 'vitest';

import { SessionEndAckResponseSchema, UpdateBodySchema } from './updates.js';

describe('updates sharing', () => {
  it('accepts session-shared updates without encryptedDataKey', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'session-shared',
      sessionId: 'sess_1',
      shareId: 'share_1',
      sharedBy: { id: 'u1', firstName: null, lastName: null, username: null, avatar: null },
      accessLevel: 'view',
      canApprovePermissions: false,
      createdAt: Date.now(),
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts approval capability on session share update payloads', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'session-share-updated',
      sessionId: 'sess_1',
      shareId: 'share_1',
      accessLevel: 'edit',
      canApprovePermissions: true,
      updatedAt: Date.now(),
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts exact pending meaningful activity timestamps on pending-changed payloads', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'pending-changed',
      sid: 'sess_1',
      sessionId: 'sess_1',
      pendingVersion: 2,
      pendingCount: 1,
      meaningfulActivityAt: 1234,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts legacy session-end socket ack payloads', () => {
    expect(SessionEndAckResponseSchema.safeParse({ ok: true, applied: false }).success).toBe(true);
    expect(SessionEndAckResponseSchema.safeParse({ ok: false, error: 'forbidden' }).success).toBe(true);
  });

  it('accepts authoritative session-end socket ack payloads', () => {
    const parsed = SessionEndAckResponseSchema.safeParse({
      ok: true,
      applied: true,
      active: false,
      activeAt: 1234,
      latestTurnId: 'turn_1',
      latestTurnStatus: 'cancelled',
      latestTurnStatusObservedAt: 1234,
      lastRuntimeIssue: null,
    });

    expect(parsed.success).toBe(true);
  });
});
