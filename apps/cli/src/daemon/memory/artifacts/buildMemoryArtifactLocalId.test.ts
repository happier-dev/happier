import { describe, expect, it } from 'vitest';

describe('buildMemoryArtifactLocalId', () => {
  it('builds deterministic localIds for summary shards and synopsis', async () => {
    const { buildSummaryShardLocalId, buildSynopsisLocalId } = await import('./buildMemoryArtifactLocalId');
    expect(buildSummaryShardLocalId({ seqFrom: 1, seqTo: 10 })).toBe('memory:summary_shard:v1:1-10');
    expect(buildSynopsisLocalId({ seqTo: 10 })).toBe('memory:synopsis:v1:10');
  });
});

