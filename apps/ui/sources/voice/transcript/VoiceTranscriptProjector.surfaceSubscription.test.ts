import { describe, expect, it, vi } from 'vitest';
import type { VoiceTranscriptCanonicalEventV1 } from '@happier-dev/protocol';

import { createVoiceTranscriptProjector } from './VoiceTranscriptProjector';

function event(overrides: Partial<VoiceTranscriptCanonicalEventV1>): VoiceTranscriptCanonicalEventV1 {
  return {
    v: 1,
    eventId: 'e1',
    epoch: 1,
    sequence: 1,
    revision: 1,
    itemId: 'item-1',
    role: 'assistant',
    provenance: 'live',
    type: 'voice.transcript.delta',
    text: 'Hel',
    ...overrides,
  };
}

describe('VoiceTranscriptProjector canonical surface subscription', () => {
  it('publishes stable partial, final, and corrected snapshots without replay duplicates', () => {
    const projector = createVoiceTranscriptProjector({ getState: () => ({}) });
    const listener = vi.fn();
    const unsubscribe = projector.subscribeCanonical('conversation-1', listener);

    projector.projectCanonicalEvent({ conversationSessionId: 'conversation-1', event: event({}) });
    const partial = projector.canonicalSnapshot('conversation-1');
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatchObject({ text: 'Hel', final: false, revision: 1, announce: 'none' });
    expect(projector.canonicalSnapshot('conversation-1')).toBe(partial);

    projector.projectCanonicalEvent({
      conversationSessionId: 'conversation-1',
      event: event({ eventId: 'e2', sequence: 2, revision: 2, type: 'voice.transcript.final', text: 'Hello' }),
    });
    projector.projectCanonicalEvent({
      conversationSessionId: 'conversation-1',
      event: event({ eventId: 'e3', sequence: 3, revision: 3, type: 'voice.transcript.corrected', text: 'Hello!' }),
    });
    const corrected = projector.canonicalSnapshot('conversation-1');
    expect(corrected).toHaveLength(1);
    expect(corrected[0]).toMatchObject({ text: 'Hello!', final: true, corrected: true, revision: 3, announce: 'polite' });
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
  });

  it('does not re-announce reconnect replay to assistive technology', () => {
    const projector = createVoiceTranscriptProjector({ getState: () => ({}) });
    projector.projectCanonicalEvent({
      conversationSessionId: 'conversation-1',
      event: event({ type: 'voice.transcript.final', provenance: 'replay', text: 'Already heard' }),
    });
    expect(projector.canonicalSnapshot('conversation-1')[0]?.announce).toBe('none');
  });
});
