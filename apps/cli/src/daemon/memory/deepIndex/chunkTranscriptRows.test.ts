import { describe, expect, it } from 'vitest';

import { chunkTranscriptRows } from './chunkTranscriptRows';

describe('chunkTranscriptRows', () => {
  it('splits rows into multiple chunks based on maxChunkMessages', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      seq: i + 1,
      createdAtMs: 1000 + i,
      role: i % 2 === 0 ? ('user' as const) : ('agent' as const),
      text: `msg-${i + 1}`,
    }));

    const chunks = chunkTranscriptRows({
      rows,
      settings: {
        maxChunkChars: 10_000,
        maxChunkMessages: 3,
        minChunkMessages: 1,
      },
    });

    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.seqFrom).toBe(1);
    expect(chunks[0]!.seqTo).toBe(3);
    expect(chunks[1]!.seqFrom).toBe(4);
    expect(chunks[1]!.seqTo).toBe(6);
    expect(chunks[2]!.seqFrom).toBe(7);
    expect(chunks[2]!.seqTo).toBe(7);
  });
});

