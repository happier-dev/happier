import type { BillingCapabilitiesV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';

// Advice, not an acquisition minimum: CLOUD45b reached Online on a 2 GiB cpx12,
// then reported critical pressure (199 MB free, no swap) with Codex (2026-11-06).
// Recommend the next 4 GiB tier; this does not establish the cause of its failed turn.
// Evidence: .project/reviews/2026-10-02-lane12-replan/impl-C/CLOUD1.md, CLOUD45b.
// Owner decision 2026-11-06: warn, don't block. Larger workloads can still need more memory.
const RECOMMENDED_CLOUD_AGENT_MEMORY_BYTES = 4 * 1024 ** 3;

export function managedSizeMemoryRecommendation(memoryBytes: number | undefined, location: BillingCapabilitiesV1['location']): number | undefined {
    return location === 'cloud' && memoryBytes !== undefined && memoryBytes < RECOMMENDED_CLOUD_AGENT_MEMORY_BYTES
        ? RECOMMENDED_CLOUD_AGENT_MEMORY_BYTES : undefined;
}
