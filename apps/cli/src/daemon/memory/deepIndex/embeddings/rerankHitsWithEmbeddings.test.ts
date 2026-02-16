import { describe, expect, it } from 'vitest';

import { rerankHitsWithEmbeddings } from './rerankHitsWithEmbeddings';

describe('rerankHitsWithEmbeddings', () => {
  it('reorders hits when cosine similarity dominates', () => {
    const queryEmbedding = new Float32Array([1, 0, 0]);
    const hits = [
      { id: 'a', baseScore: 0.5, embedding: new Float32Array([0, 1, 0]) },
      { id: 'b', baseScore: 0.5, embedding: new Float32Array([1, 0, 0]) },
    ] as const;

    const out = rerankHitsWithEmbeddings({
      hits,
      queryEmbedding,
      weights: { wFts: 0.1, wEmb: 0.9 },
    });

    expect(out[0]?.id).toBe('b');
    expect(out[0]?.finalScore).toBeGreaterThan(out[1]?.finalScore ?? -1);
  });

  it('falls back to baseScore when a hit has no embedding', () => {
    const queryEmbedding = new Float32Array([1, 0]);
    const hits = [
      { id: 'a', baseScore: 0.2, embedding: null },
      { id: 'b', baseScore: 0.9, embedding: null },
    ] as const;

    const out = rerankHitsWithEmbeddings({
      hits,
      queryEmbedding,
      weights: { wFts: 1, wEmb: 1 },
    });

    expect(out[0]?.id).toBe('b');
    expect(out[0]?.finalScore).toBeCloseTo(0.9, 6);
  });
});

