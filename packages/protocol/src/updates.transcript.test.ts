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
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.t).toBe('new-message');
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
    });

    expect(parsed.success).toBe(true);
  });
});
