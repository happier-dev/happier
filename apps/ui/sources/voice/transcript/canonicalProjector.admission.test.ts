import { describe, expect, it, vi } from 'vitest';

import { createCanonicalVoiceTranscriptProjector } from './canonicalProjector';

function finalEvent(overrides: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    type: 'voice.transcript.final' as const,
    epoch: 1,
    sequence: 1,
    revision: 1,
    eventId: 'final-1',
    itemId: 'turn-1',
    role: 'user' as const,
    text: 'exact final',
    provenance: 'live' as const,
    ...overrides,
  };
}

describe('canonical voice transcript persistence admission', () => {
  it('reserves one valid A final synchronously and commits it without replacing B currentness', () => {
    const persistFinal = vi.fn();
    let nextAttemptIdentity = 0;
    const projector = createCanonicalVoiceTranscriptProjector({
      persistFinal,
      createAttemptIdentity: () => `attempt-${++nextAttemptIdentity}`,
    });
    const a = projector.beginAttempt();
    const admission = projector.admitPersistenceEvent(finalEvent({
      epoch: a.epoch,
      eventId: 'a-final',
      itemId: 'a-turn',
      text: 'A final admitted before replacement',
    }));

    expect(admission).not.toBeNull();
    expect(projector.snapshot()).toEqual([]);
    expect(projector.project(finalEvent({
      epoch: a.epoch,
      eventId: 'a-final',
      itemId: 'a-turn',
      text: 'A final admitted before replacement',
    }))).toMatchObject({ status: 'duplicate', item: null });

    const b = projector.beginAttempt();
    expect(projector.project(finalEvent({
      epoch: b.epoch,
      eventId: 'b-final',
      itemId: 'b-turn',
      text: 'B remains current',
    }))).toMatchObject({ status: 'applied' });

    expect(projector.commitAdmittedPersistenceEvent(admission!)).toMatchObject({
      appliedToCurrentSnapshot: false,
      item: {
        attemptIdentity: a.attemptIdentity,
        itemId: 'a-turn',
        text: 'A final admitted before replacement',
        corrected: false,
      },
    });
    expect(projector.commitAdmittedPersistenceEvent(admission!)).toBeNull();
    expect(persistFinal).toHaveBeenCalledTimes(2);
    expect(projector.snapshot()).toEqual([
      expect.objectContaining({
        attemptIdentity: b.attemptIdentity,
        itemId: 'b-turn',
        text: 'B remains current',
      }),
    ]);
  });

  it('releases a canceled final reservation so the exact event can be admitted normally', () => {
    let nextAttemptIdentity = 0;
    const projector = createCanonicalVoiceTranscriptProjector({
      createAttemptIdentity: () => `attempt-${++nextAttemptIdentity}`,
    });
    const attempt = projector.beginAttempt();
    const final = finalEvent({ epoch: attempt.epoch });
    const admission = projector.admitPersistenceEvent(final);

    expect(admission).not.toBeNull();
    expect(projector.releaseAdmittedPersistenceEvent(admission!)).toBe(true);
    expect(projector.commitAdmittedPersistenceEvent(admission!)).toBeNull();
    expect(projector.project(final)).toMatchObject({ status: 'applied' });
  });

  it('reserves one valid A correction synchronously and commits it without replacing B currentness', () => {
    const persistFinal = vi.fn();
    let nextAttemptIdentity = 0;
    const projector = createCanonicalVoiceTranscriptProjector({
      persistFinal,
      createAttemptIdentity: () => `attempt-${++nextAttemptIdentity}`,
    });
    const a = projector.beginAttempt();
    const aFinal = finalEvent({
      epoch: a.epoch,
      eventId: 'a-final',
      itemId: 'a-turn',
      text: 'A persisted before correction',
    });
    expect(projector.project(aFinal)).toMatchObject({
      status: 'applied',
      item: {
        attemptIdentity: a.attemptIdentity,
        itemId: 'a-turn',
        text: 'A persisted before correction',
      },
    });
    const aCorrection = finalEvent({
      type: 'voice.transcript.corrected',
      epoch: a.epoch,
      sequence: 2,
      revision: 2,
      eventId: 'a-correction',
      itemId: 'a-turn',
      text: 'A correction admitted before replacement',
    });

    const admission = projector.admitPersistenceEvent(aCorrection);
    expect(admission).not.toBeNull();
    expect(projector.snapshot()).toEqual([
      expect.objectContaining({
        attemptIdentity: a.attemptIdentity,
        itemId: 'a-turn',
        text: 'A persisted before correction',
      }),
    ]);
    expect(projector.project(aCorrection)).toMatchObject({ status: 'duplicate', item: null });

    const b = projector.beginAttempt();
    expect(projector.project(finalEvent({
      epoch: b.epoch,
      eventId: 'b-final',
      itemId: 'b-turn',
      text: 'B remains current',
    }))).toMatchObject({ status: 'applied' });
    expect(projector.snapshot()).toEqual([
      expect.objectContaining({
        attemptIdentity: b.attemptIdentity,
        itemId: 'b-turn',
        text: 'B remains current',
      }),
    ]);

    expect(projector.commitAdmittedPersistenceEvent(admission!)).toMatchObject({
      appliedToCurrentSnapshot: false,
      item: {
        attemptIdentity: a.attemptIdentity,
        itemId: 'a-turn',
        text: 'A correction admitted before replacement',
        corrected: true,
      },
    });
    expect(projector.commitAdmittedPersistenceEvent(admission!)).toBeNull();
    expect(persistFinal).toHaveBeenCalledTimes(3);
    expect(projector.snapshot()).toEqual([
      expect.objectContaining({
        attemptIdentity: b.attemptIdentity,
        itemId: 'b-turn',
        text: 'B remains current',
      }),
    ]);
  });

  it('releases a canceled correction reservation so the exact event can be admitted normally', () => {
    let nextAttemptIdentity = 0;
    const projector = createCanonicalVoiceTranscriptProjector({
      createAttemptIdentity: () => `attempt-${++nextAttemptIdentity}`,
    });
    const attempt = projector.beginAttempt();
    const final = finalEvent({ epoch: attempt.epoch });
    expect(projector.project(final)).toMatchObject({ status: 'applied' });
    const correction = finalEvent({
      type: 'voice.transcript.corrected',
      epoch: attempt.epoch,
      sequence: 2,
      revision: 2,
      eventId: 'canceled-correction',
      text: 'released correction',
    });
    const admission = projector.admitPersistenceEvent(correction);

    expect(admission).not.toBeNull();
    expect(projector.releaseAdmittedPersistenceEvent(admission!)).toBe(true);
    expect(projector.commitAdmittedPersistenceEvent(admission!)).toBeNull();
    expect(projector.project(correction)).toMatchObject({ status: 'applied' });
  });
});
