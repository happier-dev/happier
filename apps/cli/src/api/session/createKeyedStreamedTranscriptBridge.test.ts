import { describe, expect, it, vi } from 'vitest';

import { createKeyedStreamedTranscriptBridge } from './createKeyedStreamedTranscriptBridge';

describe('keyed transcript recovery', () => {
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
