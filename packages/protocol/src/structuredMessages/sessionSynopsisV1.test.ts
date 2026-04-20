import { describe, expect, it } from 'vitest';

import { SessionSynopsisV1Schema } from './sessionSynopsisV1.js';

describe('session_synopsis.v1 schema', () => {
  it('parses a valid synopsis', () => {
    const now = Date.now();
    const parsed = SessionSynopsisV1Schema.parse({
      v: 1,
      seqTo: 120,
      updatedAtMs: now,
      synopsis: 'We are building an opt-in local memory search index on the daemon.',
    });
    expect(parsed.seqTo).toBe(120);
  });

  it('preserves additive fields from newer producers', () => {
    const now = Date.now();
    const parsed = SessionSynopsisV1Schema.parse({
      v: 1,
      seqTo: 120,
      updatedAtMs: now,
      synopsis: 'We are building an opt-in local memory search index on the daemon.',
      revision: 'v2',
      futureDetails: {
        kind: 'session_synopsis.v2',
        summaryPoints: ['A', 'B'],
      },
    });

    expect((parsed as any).revision).toBe('v2');
    expect((parsed as any).futureDetails).toEqual({
      kind: 'session_synopsis.v2',
      summaryPoints: ['A', 'B'],
    });
  });

  it('rejects empty synopsis', () => {
    const now = Date.now();
    expect(() => SessionSynopsisV1Schema.parse({
      v: 1,
      seqTo: 1,
      updatedAtMs: now,
      synopsis: '',
    })).toThrow();
  });
});
