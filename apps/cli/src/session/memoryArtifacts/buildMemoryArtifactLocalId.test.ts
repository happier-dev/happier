import { describe, expect, it } from 'vitest';

import { buildSummaryShardLocalId, buildSynopsisLocalId } from './buildMemoryArtifactLocalId';

describe('buildMemoryArtifactLocalId', () => {
  it('builds deterministic localIds for memory artifacts', () => {
    expect(buildSummaryShardLocalId({ seqFrom: 1, seqTo: 10 })).toBe('memory:summary_shard:v1:1-10');
    expect(buildSynopsisLocalId({ seqTo: 10 })).toBe('memory:synopsis:v1:10');
  });
});

