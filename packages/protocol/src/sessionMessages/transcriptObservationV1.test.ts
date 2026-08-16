import { describe, expect, it } from 'vitest';

import {
  isRecoveredHistoryTranscriptObservationProvenance,
  SessionTranscriptObservationAckV1Schema,
  SessionTranscriptObservationV1Schema,
} from './transcriptObservationV1.js';

describe('isRecoveredHistoryTranscriptObservationProvenance', () => {
  it('accepts only strict non-dependent history provenance', () => {
    expect(isRecoveredHistoryTranscriptObservationProvenance({
      kind: 'non_dependent',
      source: 'history',
    })).toBe(true);
    for (const source of ['background', 'external', 'sidechain']) {
      expect(isRecoveredHistoryTranscriptObservationProvenance({
        kind: 'non_dependent',
        source,
      })).toBe(false);
    }
    expect(isRecoveredHistoryTranscriptObservationProvenance({
      kind: 'non_dependent',
      source: 'history',
      untrusted: true,
    })).toBe(false);
    expect(isRecoveredHistoryTranscriptObservationProvenance(null)).toBe(false);
  });
});

const base = {
  v: 1 as const,
  sessionId: 'session-1',
  localId: 'assistant-1',
  messageRole: 'agent' as const,
  content: { t: 'plain' as const, v: { role: 'agent', content: { type: 'text', text: 'answer' } } },
  createdAt: 1234,
  updatedAt: 1567,
};

describe('SessionTranscriptObservationV1Schema', () => {
  it('accepts bounded non-dependent provenance', () => {
    expect(SessionTranscriptObservationV1Schema.safeParse({
      ...base,
      provenance: { kind: 'non_dependent', source: 'history' },
    }).success).toBe(true);
  });

  it('rejects missing, unknown, correlation-forging, and reversed chronology provenance', () => {
    expect(SessionTranscriptObservationV1Schema.safeParse(base).success).toBe(false);
    expect(SessionTranscriptObservationV1Schema.safeParse({
      ...base,
      provenance: { kind: 'non_dependent', source: 'guessed' },
    }).success).toBe(false);
    expect(SessionTranscriptObservationV1Schema.safeParse({
      ...base,
      provenance: {
        kind: 'non_dependent',
        source: 'history',
        sessionId: 'session-2',
        originatingPendingLocalId: 'user-1',
      },
    }).success).toBe(false);
    expect(SessionTranscriptObservationV1Schema.safeParse({
      ...base,
      updatedAt: 1200,
      provenance: { kind: 'non_dependent', source: 'history' },
    }).success).toBe(false);
    expect(SessionTranscriptObservationV1Schema.safeParse({
      ...base,
      localId: '   ',
      provenance: { kind: 'non_dependent', source: 'history' },
    }).success).toBe(false);
  });

  it('validates opaque identities without normalizing their bytes', () => {
    const parsed = SessionTranscriptObservationV1Schema.parse({
      ...base,
      sessionId: ' session-1 ',
      localId: ' assistant-1 ',
      provenance: { kind: 'non_dependent', source: 'external' },
    });

    expect(parsed.sessionId).toBe(' session-1 ');
    expect(parsed.localId).toBe(' assistant-1 ');
    expect(parsed.provenance).toEqual({
      kind: 'non_dependent',
      source: 'external',
    });
  });
});

describe('SessionTranscriptObservationAckV1Schema', () => {
  it('accepts the successful persisted observation outcome', () => {
    expect(SessionTranscriptObservationAckV1Schema.safeParse({
      ok: true,
      status: 'observed',
      id: 'message-1',
      seq: 1,
      localId: 'assistant-1',
      didWrite: true,
      ingestedAt: 2_000,
    }).success).toBe(true);
  });
});
