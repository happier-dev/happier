import type { TranscriptRenderableAggregate } from './transcriptRenderableAggregate';

/**
 * Whether an aggregate's request states are current for this `completedRequests` record: pending
 * coverage was folded against it, so a different record means the states must be rebuilt.
 * Kept in this leaf so the pending-request owner can read the store's aggregate without importing
 * the aggregate module, which itself builds on that owner.
 */
export function canReuseTranscriptRenderableAggregateRequestStates(
    aggregate: Pick<TranscriptRenderableAggregate, 'completedRequestsRef'>,
    completedRequests: Record<string, unknown> | null,
): boolean {
    return aggregate.completedRequestsRef === completedRequests;
}
