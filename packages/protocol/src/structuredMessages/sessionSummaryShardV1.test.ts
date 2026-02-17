import { describe, expect, it } from 'vitest';

import { SessionSummaryShardV1Schema } from './sessionSummaryShardV1.js';

describe('session_summary_shard.v1 schema', () => {
  it('parses a minimal valid shard', () => {
    const now = Date.now();
    const parsed = SessionSummaryShardV1Schema.parse({
      v: 1,
      seqFrom: 10,
      seqTo: 25,
      createdAtFromMs: now,
      createdAtToMs: now + 1,
      summary: 'We discussed memory search and shard indexing.',
      keywords: ['memory', 'search'],
      entities: ['Happier'],
      decisions: ['Use execution runs for summarization.'],
    });
    expect(parsed.seqFrom).toBe(10);
    expect(parsed.keywords).toHaveLength(2);
  });

  it('rejects invalid seq ranges', () => {
    const now = Date.now();
    expect(() => SessionSummaryShardV1Schema.parse({
      v: 1,
      seqFrom: 20,
      seqTo: 10,
      createdAtFromMs: now,
      createdAtToMs: now + 1,
      summary: 'Bad.',
    })).toThrow();
  });
});

