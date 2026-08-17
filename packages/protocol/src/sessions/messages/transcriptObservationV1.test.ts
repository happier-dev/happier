import { describe, expect, it } from 'vitest';

import {
  SessionTranscriptObservationAckV1Schema,
  SessionTranscriptObservationV1Schema,
  isRecoveredHistoryTranscriptObservationProvenance,
} from './transcriptObservationV1.js';

const observation = {
  v: 1 as const,
  sessionId: 'session-1',
  localId: ' historical-id ',
  content: { t: 'encrypted' as const, c: 'ciphertext' },
  createdAt: 100,
  updatedAt: 200,
  provenance: { kind: 'non_dependent' as const, source: 'history' as const },
};

describe('SessionTranscriptObservationV1', () => {
  it('preserves an exact nonblank local id and explicit content envelope', () => {
    expect(SessionTranscriptObservationV1Schema.parse(observation)).toEqual(observation);
  });

  it('rejects blank ids, inverted chronology, and expanded provenance', () => {
    expect(SessionTranscriptObservationV1Schema.safeParse({ ...observation, localId: '   ' }).success).toBe(false);
    expect(SessionTranscriptObservationV1Schema.safeParse({ ...observation, updatedAt: 99 }).success).toBe(false);
    expect(SessionTranscriptObservationV1Schema.safeParse({
      ...observation,
      provenance: { ...observation.provenance, trusted: true },
    }).success).toBe(false);
  });

  it('requires an exact observation acknowledgement', () => {
    expect(SessionTranscriptObservationAckV1Schema.safeParse({
      ok: true,
      status: 'observed',
      id: 'message-1',
      seq: 1,
      localId: ' historical-id ',
      didWrite: true,
      ingestedAt: 300,
    }).success).toBe(true);
  });

  it('classifies only strict recovered-history provenance', () => {
    expect(isRecoveredHistoryTranscriptObservationProvenance({
      kind: 'non_dependent',
      source: 'history',
    })).toBe(true);
    for (const source of ['background', 'external', 'sidechain'] as const) {
      expect(isRecoveredHistoryTranscriptObservationProvenance({
        kind: 'non_dependent',
        source,
      })).toBe(false);
    }
    expect(isRecoveredHistoryTranscriptObservationProvenance({
      kind: 'non_dependent',
      source: 'history',
      trusted: true,
    })).toBe(false);
    expect(isRecoveredHistoryTranscriptObservationProvenance(null)).toBe(false);
  });
});
