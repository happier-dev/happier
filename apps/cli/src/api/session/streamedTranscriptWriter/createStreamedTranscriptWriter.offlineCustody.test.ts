import { describe, expect, it, vi } from 'vitest';

import { createOfflineSessionStub } from '@/api/offline/offlineSessionStub';
import { createCurrentSessionTranscriptPort } from '../createCurrentSessionTranscriptPort';
import { createStreamedTranscriptWriter } from './createStreamedTranscriptWriter';

describe('createStreamedTranscriptWriter offline custody', () => {
  it('retains a failed offline segment and retries the same identity after a real session attaches', async () => {
    const offline = createOfflineSessionStub('transcript-custody');
    const enqueueAgentMessageCommitted = vi.fn(async () => ({
      persisted: true as const,
      delivered: false as const,
    }));
    const attached = {
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted,
    };
    let currentSession = offline;
    const session = createCurrentSessionTranscriptPort(() => currentSession as any);
    const writer = createStreamedTranscriptWriter({
      provider: 'claude',
      session,
      makeLocalId: () => 'offline-segment-1',
    });

    writer.appendAssistantDelta('must survive reconnect');
    await expect(writer.flushAll({ reason: 'turn-end' })).resolves.toMatchObject({
      assistantRoot: { sawText: true, didDurablyFlush: false },
    });

    currentSession = attached as any;
    await expect(writer.flushAll({ reason: 'turn-end' })).resolves.toMatchObject({
      assistantRoot: { sawText: true, didDurablyFlush: true },
    });

    expect(enqueueAgentMessageCommitted).toHaveBeenCalledOnce();
    expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'claude',
      { type: 'message', message: 'must survive reconnect' },
      expect.objectContaining({
        localId: 'offline-segment-1',
        provenance: { kind: 'non_dependent', source: 'external' },
      }),
    );
  });

  it('retains a failed terminal predecessor without absorbing or overwriting its successor', async () => {
    const offline = createOfflineSessionStub('transcript-custody');
    const enqueueAgentMessageCommitted = vi.fn(async () => ({
      persisted: true as const,
      delivered: false as const,
    }));
    const attached = {
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      enqueueAgentMessageCommitted,
    };
    let currentSession = offline;
    let nextLocalId = 0;
    const session = createCurrentSessionTranscriptPort(() => currentSession as any);
    const writer = createStreamedTranscriptWriter({
      provider: 'claude',
      session,
      makeLocalId: () => `offline-segment-${++nextLocalId}`,
    });

    writer.appendAssistantDelta('first turn');
    await expect(writer.flushAll({ reason: 'turn-end' })).resolves.toMatchObject({
      assistantRoot: { sawText: true, didDurablyFlush: false },
    });

    writer.appendAssistantDelta('second turn');
    currentSession = attached as any;
    await expect(writer.flushAll({ reason: 'turn-end' })).resolves.toMatchObject({
      assistantRoot: { sawText: true, didDurablyFlush: true },
    });

    expect(enqueueAgentMessageCommitted).toHaveBeenCalledTimes(2);
    expect(enqueueAgentMessageCommitted.mock.calls).toEqual([
      [
        'claude',
        { type: 'message', message: 'first turn' },
        expect.objectContaining({ localId: 'offline-segment-1' }),
      ],
      [
        'claude',
        { type: 'message', message: 'second turn' },
        expect.objectContaining({ localId: 'offline-segment-2' }),
      ],
    ]);
  });
});
