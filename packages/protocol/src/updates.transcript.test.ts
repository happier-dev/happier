import { describe, expect, it } from 'vitest';

import { EphemeralUpdateSchema, MessageAckResponseSchema, UpdateBodySchema, type UpdateBody } from './updates.js';

describe('updates transcript vNext payloads', () => {
  it('parses update-session payloads with session counters', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'update-session',
      id: 'sess_1',
      metadata: { value: null, version: 3 },
      agentState: { value: 'active', version: 2 },
      lastViewedSessionSeq: 11,
      pendingPermissionRequestCount: 2,
      pendingUserActionRequestCount: 3,
      pendingCount: 4,
      pendingVersion: 5,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.t).toBe('update-session');
  });

  it('types the extended update-session payload counters', () => {
    type UpdateSessionBody = Extract<UpdateBody, { t: 'update-session' }>;

    const updateSessionBody = {
      t: 'update-session',
      id: 'sess_1',
      metadata: { value: null, version: 3 },
      agentState: { value: 'active', version: 2 },
      lastViewedSessionSeq: 11,
      pendingPermissionRequestCount: 2,
      pendingUserActionRequestCount: 3,
      pendingCount: 4,
      pendingVersion: 5,
    } satisfies UpdateSessionBody;

    const lastViewedSessionSeq: number | undefined = updateSessionBody.lastViewedSessionSeq;
    const pendingPermissionRequestCount: number | undefined = updateSessionBody.pendingPermissionRequestCount;
    const pendingUserActionRequestCount: number | undefined = updateSessionBody.pendingUserActionRequestCount;
    const pendingCount: number | undefined = updateSessionBody.pendingCount;
    const pendingVersion: number | undefined = updateSessionBody.pendingVersion;

    expect(lastViewedSessionSeq).toBe(11);
    expect(pendingPermissionRequestCount).toBe(2);
    expect(pendingUserActionRequestCount).toBe(3);
    expect(pendingCount).toBe(4);
    expect(pendingVersion).toBe(5);
  });

  it('parses message-updated payload', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'message-updated',
      sid: 'sess_1',
      message: {
        id: 'm1',
        seq: 1,
        content: { t: 'encrypted', c: 'cipher' },
        localId: 'l1',
        sidechainId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.t).toBe('message-updated');
  });

  it('parses new-message payloads with sidechainId', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'new-message',
      sid: 'sess_1',
      message: {
        id: 'm1',
        seq: 1,
        content: { t: 'encrypted', c: 'cipher' },
        localId: null,
        sidechainId: 'tool_1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.t).toBe('new-message');
  });

  it('parses transcript-draft ephemerals', () => {
    const parsed = EphemeralUpdateSchema.safeParse({
      type: 'transcript-draft',
      sessionId: 'sess_1',
      localId: 'l1',
      segmentKind: 'thinking',
      sidechainId: null,
      delta: { t: 'encrypted', c: 'cipher' },
      createdAt: Date.now(),
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.type).toBe('transcript-draft');
  });

  it('parses execution-run-updated ephemerals', () => {
    const parsed = EphemeralUpdateSchema.safeParse({
      type: 'execution-run-updated',
      sessionId: 'sess_1',
      run: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        status: 'running',
        startedAtMs: Date.now(),
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.type).toBe('execution-run-updated');
  });

  it('parses message ack responses with didUpdate', () => {
    const parsed = MessageAckResponseSchema.safeParse({
      ok: true,
      id: 'm1',
      seq: 1,
      localId: 'l1',
      didWrite: false,
      didUpdate: true,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ok).toBe(true);
  });
});
