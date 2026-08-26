import { describe, expect, it } from 'vitest';

import { SessionEndAckResponseSchema, UpdateBodySchema } from './index.js';

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
      pendingActivationRequestId: 'pending-after-ui-death',
    });
    expect(parsed.success).toBe(true);
  });

  it('validates runtime activity projection on update-session payloads', () => {
    expect(UpdateBodySchema.safeParse({
      t: 'update-session',
      id: 'sess_1',
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityRevision: 2,
    }).success).toBe(true);

    expect(UpdateBodySchema.safeParse({
      t: 'update-session',
      id: 'sess_1',
      runtimeActivityState: 'active',
      runtimeActivityRevision: 3,
    }).success).toBe(false);

    expect(UpdateBodySchema.safeParse({
      t: 'update-session',
      id: 'sess_1',
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 1_000,
      runtimeActivityRevision: 2,
      runtimeActivitySourceClass: 'agent_detached_task',
    }).success).toBe(false);
  });

  it('types the split metadata layout and owner envelope on update-session payloads', () => {
    expect(UpdateBodySchema.safeParse({
      t: 'update-session',
      id: 'sess_1',
      metadataLayoutVersion: 1,
      ownerMetadata: {
        value: {
          t: 'plain',
          v: { v: 1 },
        },
      },
    }).success).toBe(true);
    expect(UpdateBodySchema.safeParse({
      t: 'update-session',
      id: 'sess_1',
      metadataLayoutVersion: 1,
      ownerMetadata: {
        value: {
          t: 'encrypted',
          c: 'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==',
        },
      },
    }).success).toBe(true);
    expect(UpdateBodySchema.safeParse({
      t: 'update-session',
      id: 'sess_1',
      metadataLayoutVersion: 1,
      ownerMetadata: {
        value: {
          t: 'plain',
          v: { v: 1 },
        },
        version: 3,
      },
    }).success).toBe(false);
    expect(UpdateBodySchema.safeParse({
      t: 'update-session',
      id: 'sess_1',
      metadataLayoutVersion: '1',
      ownerMetadata: {
        value: {
          t: 'plain',
          v: { v: 1 },
        },
      },
    }).success).toBe(false);
    expect(UpdateBodySchema.safeParse({
      t: 'update-session',
      id: 'sess_1',
      metadataLayoutVersion: 1,
      ownerMetadata: 42,
    }).success).toBe(false);
    expect(UpdateBodySchema.safeParse({
      t: 'update-session',
      id: 'sess_1',
      metadataLayoutVersion: 1,
      ownerMetadata: {
        value:
          'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==',
      },
    }).success).toBe(false);
  });

  it('validates additive blocked pending count on pending-changed payloads', () => {
    expect(UpdateBodySchema.safeParse({
      t: 'pending-changed',
      sid: 'sess_1',
      sessionId: 'sess_1',
      pendingVersion: 2,
      pendingCount: 1,
      pendingBlockedCount: 1,
    }).success).toBe(true);

    expect(UpdateBodySchema.safeParse({
      t: 'pending-changed',
      sid: 'sess_1',
      sessionId: 'sess_1',
      pendingVersion: 2,
      pendingCount: 1,
      pendingBlockedCount: -1,
    }).success).toBe(false);
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
