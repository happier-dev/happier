import { describe, expect, it, vi } from 'vitest';

import { createTurnAssistantTextSnapshotStore } from '../turns/assistantTextSnapshotStore';
import { createStreamedTranscriptWriter } from './createStreamedTranscriptWriter';

describe('createStreamedTranscriptWriter assistant text snapshots', () => {
  it('updates the current turn snapshot from root assistant deltas and overrides before flush clears segments', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const store = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 });
    store.beginTurn({ turnToken: 'turn-1', startSeqExclusive: null, startedAtMs: 0 });

    const writer = createStreamedTranscriptWriter({
      provider: 'codex',
      makeLocalId: () => 'segment-1',
      session: {
        turnAssistantTextSnapshotStore: store,
        sendAgentMessageEphemeral: vi.fn(),
        enqueueAgentMessageCommitted: vi.fn(async () => ({
          persisted: true,
          delivered: false,
        })),
      },
      initialCheckpointDelayMs: 10_000,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
      liveSnapshotIntervalMs: 10_000,
      liveSnapshotMinChars: 999,
    });

    writer.appendAssistantDelta('Ready ');
    expect(store.getCurrentTurnSnapshot({ turnToken: 'turn-1' })?.normalizedText).toBe('Ready');

    writer.overrideAssistantText('Ready for follow-up.');
    expect(store.getCurrentTurnSnapshot({ turnToken: 'turn-1' })?.normalizedText).toBe('Ready for follow-up.');

    await writer.flushAll({ reason: 'turn-end' });
    expect(store.getCurrentTurnSnapshot({ turnToken: 'turn-1' })?.normalizedText).toBe('Ready for follow-up.');
  });

  it('does not update the parent turn snapshot from sidechain deltas', () => {
    const store = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 });
    store.beginTurn({ turnToken: 'turn-1', startSeqExclusive: null, startedAtMs: 0 });

    const writer = createStreamedTranscriptWriter({
      provider: 'codex',
      session: {
        turnAssistantTextSnapshotStore: store,
        enqueueAgentMessageCommitted: vi.fn(async () => ({
          persisted: true,
          delivered: false,
        })),
      },
    });

    writer.appendAssistantDelta('Nested answer', { sidechainId: 'task-1' });

    expect(store.getCurrentTurnSnapshot({ turnToken: 'turn-1' })).toBeNull();
  });
});
