import { describe, expect, it } from 'vitest';

import { EphemeralUpdateSchema, MessageAckResponseSchema, UpdateBodySchema } from './updates.js';

describe('updates transcript vNext payloads', () => {
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
        messageRole: 'user',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.t).toBe('new-message');
    expect(parsed.data.message.messageRole).toBe('user');
  });

  it('rejects new-message payloads with unsupported messageRole values', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'new-message',
      sid: 'sess_1',
      message: {
        id: 'm1',
        seq: 1,
        content: { t: 'encrypted', c: 'cipher' },
        localId: null,
        messageRole: 'tool',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('parses new-message payloads with unknown additional fields (rolling upgrade safety)', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'new-message',
      sid: 'sess_1',
      message: {
        id: 'm1',
        seq: 1,
        content: { t: 'encrypted', c: 'cipher' },
        localId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        extraFieldAddedInFuture: { anything: true },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses update-session archivedAt changes', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'update-session',
      id: 'sess_1',
      archivedAt: 1_700_000_000_000,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.t).toBe('update-session');
    expect(parsed.data.archivedAt).toBe(1_700_000_000_000);
  });

  it('rejects update-session payloads with overlong latestTurnId values', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'update-session',
      id: 'sess_1',
      latestTurnId: 't'.repeat(192),
    });

    expect(parsed.success).toBe(false);
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

  it('parses transcript-stream-segment ephemerals', () => {
    const parsed = EphemeralUpdateSchema.safeParse({
      type: 'transcript-stream-segment',
      sessionId: 'sess_1',
      message: {
        localId: 'segment_1',
        sidechainId: 'tool_1',
        messageRole: 'agent',
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'acp',
              provider: 'codex',
              data: { type: 'message', message: 'Hello' },
            },
            meta: {
              happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: 'segment_1',
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_010,
              },
            },
          },
        },
        createdAt: 1_000,
        updatedAt: 1_010,
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.type).toBe('transcript-stream-segment');
    expect(parsed.data.message.localId).toBe('segment_1');
    expect(parsed.data.message.messageRole).toBe('agent');
  });

  it('parses direct-session transcript delta ephemerals', () => {
    const parsed = EphemeralUpdateSchema.safeParse({
      type: 'direct-session-transcript-delta',
      sessionId: 'sess_1',
      items: [
        {
          id: 'a2',
          createdAtMs: 1_050,
          localId: 'direct-2',
          raw: {
            type: 'assistant',
            uuid: 'a2',
            message: {
              model: 'm',
              content: [{ type: 'text', text: 'hello from push' }],
            },
          },
        },
      ],
      nextCursor: 'cursor-2',
      truncated: false,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.type).toBe('direct-session-transcript-delta');
    expect(parsed.data.items).toHaveLength(1);
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

  it('parses message ack responses with forward-compatible extra fields', () => {
    const parsed = MessageAckResponseSchema.safeParse({
      ok: true,
      id: 'm1',
      seq: 1,
      localId: 'l1',
      didWrite: true,
      extraFromFutureServer: { whatever: true },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses update-session payloads with forward-compatible versioned fields', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'update-session',
      id: 'sess_1',
      metadata: {
        value: 'cipher',
        version: 1,
        futureField: { ok: true },
      },
      agentState: {
        value: null,
        version: 2,
        anotherFutureField: 'hello',
      },
      active: false,
      activeAt: 1_233,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ active: false, activeAt: 1_233 });
  });
});
