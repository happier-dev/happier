import { describe, expect, it, vi } from 'vitest';

import { createKeyedStreamedTranscriptBridge } from './createKeyedStreamedTranscriptBridge';

describe('keyed transcript recovery', () => {
  it('retains the exact foreground turn on a named final and an unnamed final checkpoint', async () => {
    const committed: { localId: string; turnId: unknown }[] = [];
    const bridge = createKeyedStreamedTranscriptBridge({ provider: 'codex',
      initialCheckpointDelayMs: 60_000,
      createSessionForStream: () => ({
        enqueueAgentMessageCommitted: async (_provider, _body, options) => {
          committed.push({ localId: options.localId, turnId: options.meta?.runtimeTurnId });
          return { persisted: true, delivered: true };
        },
      }),
    });
    try {
      bridge.appendAssistantDelta({ streamKey: 'first', sidechainId: null, foregroundTurnId: 'first-turn', messageId: 'first-message', deltaText: 'First' });
      bridge.appendAssistantDelta({ streamKey: 'second', sidechainId: null, foregroundTurnId: 'second-turn', deltaText: 'Second' });
      await bridge.flushAll({ reason: 'turn-end' });
      expect([...new Map(committed.map(row => [row.localId, row])).values()]).toEqual([
        { localId: 'first-message', turnId: 'first-turn' },
        { localId: expect.any(String), turnId: 'second-turn' },
      ]);
    } finally { bridge.clear(); }
  });

  it.each(['Inspecting the working tree', 'Inspected the working tree'])(
    'reconciles the native final %j with the same durable row after a tool boundary',
    async (finalText) => {
      vi.useFakeTimers();
      const rows = new Map<string, { message: string; startedAtMs: number; seq: number; sourceId?: unknown }>();
      const checkpointWrites: string[] = [];
      let livePublications = 0;
      const bridge = createKeyedStreamedTranscriptBridge({
        provider: 'opencode',
        initialCheckpointDelayMs: 60_000,
        createSessionForStream: () => ({
          sendAgentMessageEphemeral: () => {
            livePublications += 1;
            return { accepted: true, epoch: 0 };
          },
          enqueueAgentMessageCommitted: async (_provider, body, opts) => {
            const meta = opts.meta?.happierStreamSegmentV1;
            if (body.type !== 'message' || !meta || typeof meta !== 'object'
              || !('startedAtMs' in meta) || typeof meta.startedAtMs !== 'number') {
              throw new Error('Expected an assistant stream snapshot');
            }
            const existing = rows.get(opts.localId);
            if (existing && existing.startedAtMs !== meta.startedAtMs) {
              throw new Error('Home rejects a different source creation time for an existing local ID');
            }
            const seq = existing?.seq ?? rows.size + 3;
            checkpointWrites.push(opts.localId);
            rows.set(opts.localId, {
              message: body.message,
              startedAtMs: meta.startedAtMs,
              seq,
              ...('sourceMessageId' in meta ? { sourceId: meta.sourceMessageId } : {}),
            });
            return { persisted: true, delivered: true, committedSequence: seq };
          },
        }),
      });
      const stream = {
        streamKey: 'named-assistant-stream',
        sidechainId: null,
        messageId: 'opencode:native-session:native-message',
        foregroundTurnId: 'turn-1',
      };
      try {
        vi.setSystemTime(1000);
        bridge.appendAssistantDelta({ ...stream, deltaText: 'Inspecting the working tree' });
        vi.setSystemTime(1100);
        await bridge.flushAll({ reason: 'tool-call-boundary' });
        expect(rows.get(stream.messageId)).toEqual({
          message: 'Inspecting the working tree', startedAtMs: 1000, seq: 3,
        });

        const publicationsAtCheckpoint = livePublications;
        await bridge.flushAll({ reason: 'tool-call-boundary' });
        expect(livePublications).toBe(publicationsAtCheckpoint);
        expect(checkpointWrites).toEqual([stream.messageId]);

        vi.setSystemTime(2000);
        const final = await bridge.finalizeSegment({
          ...stream,
          channel: 'assistant',
          sourceMessageId: stream.messageId,
          text: finalText,
        });
        expect(final?.segments).toMatchObject([{ didDeliver: true, committedSequence: 3 }]);
        expect(rows.get(stream.messageId)).toEqual({
          message: finalText, startedAtMs: 1000, seq: 3, sourceId: stream.messageId,
        });
      } finally {
        bridge.clear();
        vi.useRealTimers();
      }
    },
  );

  it('flushes only selected stream scope and leaves child text open for later deltas', async () => {
    vi.useFakeTimers();
    const stored: unknown[] = [];
    const bridge = createKeyedStreamedTranscriptBridge<{ streamKey: string; sidechainId: string | null; foregroundTurnId?: string }>({
      provider: 'codex', initialCheckpointDelayMs: 60_000,
      createSessionForStream: () => ({
        sendAgentMessageEphemeral: () => ({ accepted: true, epoch: 0 }),
        enqueueAgentMessageCommitted: async (_provider, body) => {
          stored.push(body); return { persisted: true, delivered: false };
        },
      }),
    });
    bridge.appendAssistantDelta({ streamKey: 'foreground', sidechainId: null, foregroundTurnId: 'turn-1', deltaText: 'Foreground' });
    bridge.appendAssistantDelta({ streamKey: 'child', sidechainId: 'child-1', deltaText: 'Before ' });
    await bridge.flushAll({ reason: 'abort', interruptedReason: 'cancelled', selectStream: (stream) => stream.foregroundTurnId === 'turn-1' });
    expect(stored).toEqual([{ type: 'message', message: 'Foreground' }]);
    bridge.appendAssistantDelta({ streamKey: 'child', sidechainId: 'child-1', deltaText: 'after' });
    await bridge.flushAll({ reason: 'turn-end' });
    expect(stored).toEqual([
      { type: 'message', message: 'Foreground' },
      { type: 'message', message: 'Before after', sidechainId: 'child-1' },
    ]);
  });

  it('retains a failed terminal checkpoint without absorbing a successor or changing its state', async () => {
    vi.useFakeTimers();
    let connected = true;
    const stored = new Map<string, { body: unknown; meta: Record<string, unknown> | undefined }>();
    const bridge = createKeyedStreamedTranscriptBridge({
      provider: 'codex',
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 60_000,
      checkpointMinChars: 1_000_000,
      createSessionForStream: () => ({
        sendAgentMessageEphemeral: () => ({ accepted: true, epoch: 0 }),
        enqueueAgentMessageCommitted: async (_provider, body, opts) => {
          if (!connected) throw new Error('session transport is offline');
          stored.set(opts.localId, { body, meta: opts.meta });
          return { persisted: true, delivered: false };
        },
      }),
    });
    const stream = { streamKey: 'assistant-demo', sidechainId: null };
    bridge.appendAssistantDelta({ ...stream, deltaText: 'Hello ' });
    await vi.advanceTimersByTimeAsync(0);
    const originalLocalId = [...stored.keys()][0]!;
    expect(stored.get(originalLocalId)?.body).toEqual({ type: 'message', message: 'Hello ' });
    bridge.appendAssistantDelta({ ...stream, deltaText: 'world' });
    connected = false;
    expect(await bridge.flushAll({ reason: 'turn-end' })).toMatchObject([
      { assistant: { sawText: true, didDurablyFlush: false } },
    ]);
    bridge.appendAssistantDelta({ ...stream, deltaText: 'Next reply' });
    connected = true;
    await bridge.flushAll({ reason: 'abort', interruptedReason: 'cancelled' });
    expect(stored.get(originalLocalId)).toMatchObject({
      body: { type: 'message', message: 'Hello world' },
      meta: { happierStreamSegmentV1: { segmentState: 'complete' } },
    });
    expect([...stored.values()].find((row) => row.body !== stored.get(originalLocalId)?.body)).toMatchObject({
      body: { type: 'message', message: 'Next reply' },
      meta: { happierStreamSegmentV1: { segmentState: 'interrupted', interruptedReason: 'cancelled' } },
    });
    const recovered = [...stored.entries()];
    await bridge.flushAll({ reason: 'turn-end' });
    expect([...stored.entries()]).toEqual(recovered);
  });

  it('keeps text appended while a terminal flush awaits local persistence', async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const stored: unknown[] = [];
    const bridge = createKeyedStreamedTranscriptBridge({
      provider: 'codex',
      initialCheckpointDelayMs: 60_000,
      createSessionForStream: () => ({
        sendAgentMessageEphemeral: () => ({ accepted: true, epoch: 0 }),
        enqueueAgentMessageCommitted: async (_provider, body) => {
          if (body.type === 'message' && body.message === 'Before') await pending;
          stored.push(body);
          return { persisted: true, delivered: false };
        },
      }),
    });
    const stream = { streamKey: 'same-key', sidechainId: null };
    bridge.appendAssistantDelta({ ...stream, deltaText: 'Before' });
    const flush = bridge.flushAll({ reason: 'turn-end' });
    await Promise.resolve();
    bridge.appendAssistantDelta({ ...stream, deltaText: 'After' });
    resolve();
    await flush;
    await bridge.flushAll({ reason: 'turn-end' });
    expect(stored).toEqual([
      { type: 'message', message: 'Before' },
      { type: 'message', message: 'After' },
    ]);
  });
});
