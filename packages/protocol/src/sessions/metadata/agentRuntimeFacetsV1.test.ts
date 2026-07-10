import { describe, expect, it } from 'vitest';

import * as runtimeFacets from './agentRuntimeFacetsV1.js';

describe('agentRuntimeFacetsV1', () => {
  it('parses a transcript-source publication envelope', () => {
    expect(runtimeFacets.AgentRuntimeFacetsV1Schema.parse({
      v: 1,
      transcriptSource: {
        supported: true,
        followLeaseSupported: true,
      },
      extra: 'x',
    })).toEqual({
      v: 1,
      transcriptSource: {
        supported: true,
        followLeaseSupported: true,
      },
      extra: 'x',
    });
  });

  it('rejects invalid transcript-source shapes', () => {
    expect(runtimeFacets.readAgentRuntimeFacetsV1({
      v: 1,
      transcriptSource: {
        supported: false,
      },
    })).toBeNull();
  });

  it('fails closed on unsupported versions while preserving passthrough data on valid reads', () => {
    expect(runtimeFacets.readAgentRuntimeFacetsV1({
      v: 1,
      transcriptSource: {
        supported: true,
        followLeaseSupported: true,
        transport: 'socket',
      },
      publishedBy: 'runtime.publication',
    })).toEqual({
      v: 1,
      transcriptSource: {
        supported: true,
        followLeaseSupported: true,
        transport: 'socket',
      },
      publishedBy: 'runtime.publication',
    });

    expect(runtimeFacets.readAgentRuntimeFacetsV1({
      v: 2,
      transcriptSource: {
        supported: true,
      },
    })).toBeNull();
  });
});
