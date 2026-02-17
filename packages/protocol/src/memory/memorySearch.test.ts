import { describe, expect, it } from 'vitest';

import { MemorySearchErrorCodeSchema, MemorySearchQueryV1Schema, MemorySearchResultV1Schema } from './memorySearch.js';

describe('memory_search_result.v1 schema', () => {
  it('parses a success result', () => {
    const parsed = MemorySearchResultV1Schema.parse({
      v: 1,
      ok: true,
      hits: [
        {
          sessionId: 'sess_1',
          seqFrom: 10,
          seqTo: 25,
          createdAtFromMs: 1000,
          createdAtToMs: 2000,
          summary: 'We discussed OpenClaw memory indexing.',
          score: 0.42,
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    expect((parsed as any).hits).toHaveLength(1);
  });

  it('parses a failure result with stable error codes', () => {
    expect(MemorySearchErrorCodeSchema.parse('memory_disabled')).toBe('memory_disabled');
    const parsed = MemorySearchResultV1Schema.parse({
      v: 1,
      ok: false,
      errorCode: 'memory_disabled',
      error: 'Memory search is disabled.',
    });
    expect(parsed.ok).toBe(false);
  });
});

describe('MemorySearchQueryV1Schema', () => {
  it('parses a basic query', () => {
    const parsed = MemorySearchQueryV1Schema.parse({
      v: 1,
      query: 'openclaw',
      scope: { type: 'global' },
      mode: 'auto',
      maxResults: 20,
      minScore: 0.15,
    });
    expect(parsed.query).toBe('openclaw');
  });
});

