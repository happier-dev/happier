import { describe, expect, it, vi } from 'vitest';

import { createKeyedStreamedTranscriptBridge } from './createKeyedStreamedTranscriptBridge';

type TranscriptCall = {
  provider: string;
  body: unknown;
  localId: string;
  meta: Record<string, unknown> | undefined;
};

async function settleSnapshots() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createKeyedStreamedTranscriptBridge', () => {
  it('forwards live and durable cadence options into created writers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const durableCalls: TranscriptCall[] = [];
    const liveCalls: TranscriptCall[] = [];
    const session = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageEphemeral: (provider: string, body: unknown, opts: { localId: string; meta?: Record<string, unknown> }) => {
        liveCalls.push({ provider, body, localId: opts.localId, meta: opts.meta });
      },
      sendAgentMessageCommitted: async (provider: string, body: unknown, opts: { localId: string; meta?: Record<string, unknown> }) => {
        durableCalls.push({ provider, body, localId: opts.localId, meta: opts.meta });
      },
    };

    const bridge = createKeyedStreamedTranscriptBridge<{
      streamKey: string;
      sidechainId: string | null;
    }>({
      provider: 'codex',
      createSessionForStream: () => session,
      initialCheckpointDelayMs: 200,
      checkpointIntervalMs: 2_000,
      checkpointMinChars: 256,
      liveSnapshotIntervalMs: 40,
      liveSnapshotMinChars: 1,
    });

    bridge.appendAssistantDelta({ streamKey: 'item-1', sidechainId: null, deltaText: 'Hello' });
    await settleSnapshots();

    expect(liveCalls).toHaveLength(1);
    expect(durableCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);
    await settleSnapshots();

    expect(durableCalls).toHaveLength(1);
    expect(durableCalls[0]).toMatchObject({
      provider: 'codex',
      body: { type: 'message', message: 'Hello' },
    });
  });
});
