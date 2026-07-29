import { describe, expect, it } from 'vitest';

import { EphemeralUpdateSchema, MessageAckResponseSchema, UpdateBodySchema } from './index.js';

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

  it('parses source chronology and strict transcript observation provenance separately from ingestion time', () => {
    const parsed = UpdateBodySchema.parse({
      t: 'new-message',
      sid: 'sess_1',
      message: {
        id: 'm1',
        seq: 1,
        content: { t: 'encrypted', c: 'cipher' },
        localId: 'l1',
        createdAt: 1_000,
        updatedAt: 1_100,
        sourceCreatedAt: 100,
        sourceUpdatedAt: 200,
        transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
      },
    });

    expect(parsed.message).toMatchObject({
      createdAt: 1_000,
      sourceCreatedAt: 100,
      sourceUpdatedAt: 200,
      transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
    });
  });

  it('parses minimal manual-handled delivery provenance and rejects expanded shapes', () => {
    const base = {
      t: 'new-message' as const,
      sid: 'sess_1',
      message: {
        id: 'm1',
        seq: 1,
        content: { t: 'encrypted' as const, c: 'cipher' },
        localId: 'l1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    };

    expect(UpdateBodySchema.parse({
      ...base,
      message: { ...base.message, deliveryResolution: { v: 1, kind: 'manual_handled' } },
    }).message.deliveryResolution).toEqual({ v: 1, kind: 'manual_handled' });
    expect(UpdateBodySchema.safeParse({
      ...base,
      message: { ...base.message, deliveryResolution: { v: 1, kind: 'manual_handled', receipt: 'forbidden' } },
    }).success).toBe(false);
  });

  it('parses new-message payloads with trusted message attention impact', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'new-message',
      sid: 'sess_1',
      message: {
        id: 'm1',
        seq: 1,
        content: { t: 'encrypted', c: 'cipher' },
        localId: 'agent-quota-wait:openai-codex:happier:reset_at_100',
        messageRole: 'event',
        attentionImpact: {
          affectsUnread: false,
          affectsMeaningfulActivity: false,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.t).toBe('new-message');
    expect(parsed.data.message.attentionImpact).toEqual({
      affectsUnread: false,
      affectsMeaningfulActivity: false,
    });
  });

  it('rejects new-message payloads with malformed message attention impact', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'new-message',
      sid: 'sess_1',
      message: {
        id: 'm1',
        seq: 1,
        content: { t: 'encrypted', c: 'cipher' },
        localId: 'agent-quota-wait:openai-codex:happier:reset_at_100',
        messageRole: 'event',
        attentionImpact: {
          affectsUnread: 'no',
          affectsMeaningfulActivity: false,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    expect(parsed.success).toBe(false);
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
              agentId: 'codex',
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

  it('parses transcript-stream-segment ephemerals with a live-stream tick checkpoint anchor', () => {
    const parsed = EphemeralUpdateSchema.safeParse({
      type: 'transcript-stream-segment',
      sessionId: 'sess_1',
      message: {
        localId: 'segment_1',
        content: { t: 'encrypted', c: 'cipher' },
        messageRole: 'agent',
        tick: 25,
        createdAt: 1_000,
        updatedAt: 1_010,
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.type).toBe('transcript-stream-segment');
    if (parsed.data.type !== 'transcript-stream-segment') return;
    expect(parsed.data.message.tick).toBe(25);
  });

  it('parses transcript-stream-segment-delta ephemerals', () => {
    const parsed = EphemeralUpdateSchema.safeParse({
      type: 'transcript-stream-segment-delta',
      sessionId: 'sess_1',
      message: {
        localId: 'segment_1',
        sidechainId: 'tool_1',
        content: { t: 'encrypted', c: 'cipher-of-delta-only' },
        messageRole: 'agent',
        tick: 3,
        baseLength: 120,
        createdAt: 1_000,
        updatedAt: 1_010,
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.type).toBe('transcript-stream-segment-delta');
    if (parsed.data.type !== 'transcript-stream-segment-delta') return;
    expect(parsed.data.message.tick).toBe(3);
    expect(parsed.data.message.baseLength).toBe(120);
  });

  it('rejects transcript-stream-segment-delta ephemerals without tick/baseLength chaining fields', () => {
    const base = {
      type: 'transcript-stream-segment-delta',
      sessionId: 'sess_1',
      message: {
        localId: 'segment_1',
        content: { t: 'encrypted', c: 'cipher' },
        messageRole: 'agent',
        createdAt: 1_000,
        updatedAt: 1_010,
      },
    };

    expect(EphemeralUpdateSchema.safeParse(base).success).toBe(false);
    expect(
      EphemeralUpdateSchema.safeParse({
        ...base,
        message: { ...base.message, tick: 1 },
      }).success,
    ).toBe(false);
    expect(
      EphemeralUpdateSchema.safeParse({
        ...base,
        message: { ...base.message, tick: 0, baseLength: 0 },
      }).success,
    ).toBe(false);
    expect(
      EphemeralUpdateSchema.safeParse({
        ...base,
        message: { ...base.message, tick: 1, baseLength: -1 },
      }).success,
    ).toBe(false);
  });

  it('parses transcript-stream-segment-delta ephemerals with unknown additional fields (rolling upgrade safety)', () => {
    const parsed = EphemeralUpdateSchema.safeParse({
      type: 'transcript-stream-segment-delta',
      sessionId: 'sess_1',
      message: {
        localId: 'segment_1',
        content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'message', message: 'delta' } } } },
        tick: 1,
        baseLength: 0,
        createdAt: 1_000,
        updatedAt: 1_010,
        futureField: true,
      },
      futureTopLevel: 1,
    });

    expect(parsed.success).toBe(true);
  });

  it('parses content-free external-session transcript invalidations', () => {
    const parsed = EphemeralUpdateSchema.safeParse({
      v: 1,
      type: 'external-session-transcript-invalidated',
      binding: {
        v: 1,
        machineId: 'machine-1',
        sessionId: 'sess_1',
        link: { generation: 'link-1', remoteSessionId: 'remote-1' },
        source: {
          qualifiedIdentity: {
            v: 1,
            agent: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', contractVersion: 1 },
          },
          generation: 'source-1',
        },
        contributionGeneration: 'contribution-1',
        cursorIdentity: `external_session_cursor_binding_v1:${'a'.repeat(64)}`,
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.type).toBe('external-session-transcript-invalidated');
    expect(parsed.data).not.toHaveProperty('items');
  });

  // Provenance: remote-dev@24b6016fce2bee0e741a8fbb50ccdc5631b24ad0
  // packages/protocol/src/updates.ts#DirectSessionTranscriptDeltaEphemeralSchema.
  it('rejects the transcript-bearing remote-dev@24b6016 predecessor delta instead of adding a raw-frame compatibility path', () => {
    const parsed = EphemeralUpdateSchema.safeParse({
      type: 'direct-session-transcript-delta',
      sessionId: 'sess_1',
      items: [{ id: 'secret', createdAtMs: 1, raw: { text: 'plaintext' } }],
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      truncated: false,
    });

    expect(parsed.success).toBe(false);
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
