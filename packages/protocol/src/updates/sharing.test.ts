import { describe, expect, it } from 'vitest';

import { SessionEndAckResponseSchema, UpdateBodySchema, EphemeralUpdateSchema } from './index.js';

describe('updates sharing', () => {
  it('accepts only content-free installed Machine usage source wakes', () => {
    const wake = { type: 'usage-sources-invalidated', machineId: 'machine', installationId: 'installation' };
    expect(EphemeralUpdateSchema.parse(wake)).toEqual(wake);
    expect(EphemeralUpdateSchema.safeParse({ ...wake, root: '/private/source' }).success).toBe(false);
    expect(EphemeralUpdateSchema.safeParse({ ...wake, sourceId: 'private-source' }).success).toBe(false);
    expect(EphemeralUpdateSchema.safeParse({ ...wake, installationId: '' }).success).toBe(false);
  });
  it('accepts only exact content-free requester activation hints on the existing ephemeral carrier', () => {
    const hint = { type: 'pending-activation-requested', target: { homeId: 'home', accountId: 'requester', sessionId: 'session', machineId: 'machine', installationId: 'installation' }, requestId: 'pending', requestedAt: 1, pendingVersion: 1 };
    expect(EphemeralUpdateSchema.parse(hint)).toEqual(hint);
    expect(EphemeralUpdateSchema.safeParse({ ...hint, seq: 42 }).success).toBe(false);
    expect(EphemeralUpdateSchema.safeParse({ ...hint, prompt: 'private' }).success).toBe(false);
    expect(EphemeralUpdateSchema.safeParse({ ...hint, target: { ...hint.target, bearer: 'private' } }).success).toBe(false);
  });
  it('validates private Artifact revision metadata separately from public content updates', () => {
    const update = { t: 'update-artifact', artifactId: 'artifact', body: { value: 'AQIDBA==', version: 2 } };
    expect(UpdateBodySchema.safeParse({ ...update, provenance: 'AQIDBA==', provenanceDataEncryptionKey: 'AQIDBA==' }).success).toBe(true);
    expect(UpdateBodySchema.safeParse({ ...update, provenance: null, provenanceDataEncryptionKey: null }).success).toBe(true);
    expect(UpdateBodySchema.safeParse({ ...update, provenance: { savedBy: 'actor' } }).success).toBe(false);
    expect(UpdateBodySchema.safeParse({ ...update, provenanceDataEncryptionKey: 42 }).success).toBe(false);
  });

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

  it('accepts a released 0.2 session-shared update that still carries encryptedDataKey', () => {
    // A supported released 0.2 Home still emits the key bytes on this event
    // (`apps/server/sources/app/events/eventPayloadBuilders.ts` in `../0.2`),
    // so the current client must keep parsing that exact payload even though
    // 0.3 never writes it and no reader consumes it.
    const parsed = UpdateBodySchema.safeParse({
      t: 'session-shared',
      sessionId: 'sess_1',
      sid: 'sess_1',
      shareId: 'share_1',
      sharedBy: { id: 'u1', firstName: null, lastName: null, username: null, avatar: null },
      accessLevel: 'view',
      canApprovePermissions: false,
      encryptedDataKey: 'AQIDBA==',
      createdAt: Date.now(),
    });
    expect(parsed.success).toBe(true);

    // The released field stays declared rather than becoming an unvalidated
    // passthrough key: dropping the declaration would silently admit a payload
    // no released producer can emit.
    expect(UpdateBodySchema.safeParse({
      t: 'session-shared',
      sessionId: 'sess_1',
      shareId: 'share_1',
      sharedBy: { id: 'u1', firstName: null, lastName: null, username: null, avatar: null },
      accessLevel: 'view',
      canApprovePermissions: false,
      encryptedDataKey: 42,
      createdAt: Date.now(),
    }).success).toBe(false);
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

  it('accepts an exact execution-run recovery hint on pending-changed payloads', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'pending-changed',
      sid: 'sess_1',
      sessionId: 'sess_1',
      pendingVersion: 3,
      pendingCount: 1,
      recipient: { kind: 'execution_run', runId: 'run_1' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.t === 'pending-changed') {
      expect(parsed.data.recipient).toEqual({ kind: 'execution_run', runId: 'run_1' });
    }
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
