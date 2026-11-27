import { describe, expect, it, vi } from 'vitest';

import { createCanonicalVoiceTranscriptProjector } from './canonicalProjector';

describe('canonical voice transcript event retention', () => {
  it.each(['direct', 'admitted'] as const)(
    'releases finalized partial event IDs through %s commits while retaining final protection and order',
    (commitPath) => {
      const persistFinal = vi.fn();
      const projector = createCanonicalVoiceTranscriptProjector({ persistFinal });
      const { epoch } = projector.beginAttempt();
      let sequence = 0;
      const openDelta = {
        v: 1 as const,
        type: 'voice.transcript.delta' as const,
        epoch,
        sequence: ++sequence,
        revision: 1,
        eventId: 'open-delta',
        itemId: 'open-item',
        role: 'assistant' as const,
        text: 'still open',
        provenance: 'live' as const,
      };

      // Observe native collection retention without replacing any projector logic
      // or adding a production-only diagnostics interface.
      const mapSet = vi.spyOn(Map.prototype, 'set');
      let retainedEventIds: Map<unknown, unknown>;
      try {
        expect(projector.project(openDelta).status).toBe('applied');
        const eventMapCall = mapSet.mock.calls.findIndex(([key]) => key === openDelta.eventId);
        expect(eventMapCall).toBeGreaterThanOrEqual(0);
        retainedEventIds = mapSet.mock.contexts[eventMapCall]!;
      } finally {
        mapSet.mockRestore();
      }

      const turnCount = 200;
      const deltasPerTurn = 256;
      const finals = [];
      for (let turn = 0; turn < turnCount; turn += 1) {
        const itemId = `turn-${turn}`;
        for (let delta = 0; delta < deltasPerTurn; delta += 1) {
          const partial = {
            ...openDelta,
            itemId,
            eventId: `${itemId}-delta-${delta}`,
            sequence: ++sequence,
            revision: delta + 1,
            text: 'a',
          };
          expect(projector.project(partial).status).toBe('applied');
          if (delta === 0) expect(projector.project(partial).status).toBe('duplicate');
        }
        const final = {
          ...openDelta,
          type: 'voice.transcript.final' as const,
          itemId,
          eventId: `${itemId}-final`,
          sequence: ++sequence,
          revision: deltasPerTurn + 1,
          text: `final ${turn}`,
        };
        finals.push(final);
        if (commitPath === 'direct') {
          expect(projector.project(final).status).toBe('applied');
        } else {
          const admission = projector.admitPersistenceEvent(final);
          expect(admission).not.toBeNull();
          // Admission alone must not discard the still-visible partial's IDs.
          expect(retainedEventIds.size).toBe(turn + deltasPerTurn + 1);
          expect(projector.commitAdmittedPersistenceEvent(admission!)).toMatchObject({
            appliedToCurrentSnapshot: true,
            item: { itemId, text: final.text, final: true },
          });
        }
        expect(retainedEventIds.size).toBe(turn + 2);
        expect(retainedEventIds.has(`${itemId}-delta-0`)).toBe(false);
        expect(projector.project(openDelta).status).toBe('duplicate');
      }

      const firstFinal = finals[0]!;
      expect(projector.project({ ...firstFinal, provenance: 'replay' }).status).toBe('duplicate');
      expect(projector.admitPersistenceEvent(firstFinal)).toBeNull();
      expect(projector.project({
        ...firstFinal,
        itemId: 'conflicting-item',
        sequence: sequence + 1,
      }).status).toBe('rejected');
      expect(projector.project({
        ...firstFinal,
        itemId: 'out-of-order-item',
        eventId: 'out-of-order-event',
        sequence: sequence - 1,
      }).status).toBe('rejected');
      expect(persistFinal).toHaveBeenCalledTimes(turnCount);
      expect(projector.snapshot().map(({ itemId, text }) => ({ itemId, text }))).toEqual([
        { itemId: 'open-item', text: 'still open' },
        ...finals.map(({ itemId, text }) => ({ itemId, text })),
      ]);

      const correction = {
        ...firstFinal,
        type: 'voice.transcript.corrected' as const,
        eventId: 'first-final-correction',
        sequence: ++sequence,
        revision: firstFinal.revision + 1,
        text: 'corrected first final',
      };
      expect(projector.project(correction).status).toBe('applied');
      expect(projector.project(correction).status).toBe('duplicate');
      expect(projector.project(firstFinal).status).toBe('duplicate');
      expect(retainedEventIds.size).toBe(turnCount + 2);
      expect(projector.snapshot()[1]).toMatchObject({ itemId: firstFinal.itemId, text: correction.text });
      expect(persistFinal).toHaveBeenCalledTimes(turnCount + 1);
    },
  );
});
