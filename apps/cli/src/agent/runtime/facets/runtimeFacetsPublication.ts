import type { RuntimeFacets } from '@happier-dev/agents';
import {
  readAgentRuntimeFacetsV1,
  type AgentRuntimeFacetsV1,
} from '@happier-dev/protocol';

export function buildPublishedRuntimeFacetsV1(
  facets: RuntimeFacets | null | undefined,
): AgentRuntimeFacetsV1 | null {
  if (!facets?.transcriptSource) {
    return null;
  }
  return {
    v: 1,
    transcriptSource: {
      supported: true,
      ...(typeof facets.transcriptSource.acquireFollowLease === 'function'
        ? { followLeaseSupported: true }
        : {}),
    },
  };
}

export function normalizePublishedRuntimeFacetsV1(value: unknown): AgentRuntimeFacetsV1 | null {
  return readAgentRuntimeFacetsV1(value);
}
