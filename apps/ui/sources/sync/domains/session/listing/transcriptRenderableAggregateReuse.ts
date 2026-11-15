import type { AgentStateRequestCoverageOptions } from '@happier-dev/agents';

import type { TranscriptRenderableAggregate } from './transcriptRenderableAggregate';

/**
 * Whether an aggregate's request states are current for these completions and coverage: pending
 * coverage was folded against them, so a different record means the states must be rebuilt.
 * Kept in this leaf so the pending-request owner can read the Store's aggregate without importing
 * the aggregate module, which itself builds on that owner.
 */
export function canReuseTranscriptRenderableAggregateRequestStates(
    aggregate: Pick<TranscriptRenderableAggregate, 'completedRequestsRef' | 'requestCoverageRef'>,
    completedRequests: Record<string, unknown> | null,
    requestCoverage?: AgentStateRequestCoverageOptions,
): boolean {
    return aggregate.completedRequestsRef === completedRequests && aggregate.requestCoverageRef === requestCoverage;
}

export function isTranscriptRenderableAggregate(value: unknown): value is TranscriptRenderableAggregate {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<TranscriptRenderableAggregate>;
    return candidate.requestStates instanceof Map
        && typeof candidate.messageCount === 'number'
        && Number.isFinite(candidate.messageCount)
        && (candidate.latestCommittedMessageSeq === null || typeof candidate.latestCommittedMessageSeq === 'number')
        && (candidate.latestCommittedMessageCreatedAt === null || typeof candidate.latestCommittedMessageCreatedAt === 'number')
        && 'firstUserTextMessage' in candidate
        && 'completedRequestsRef' in candidate;
}
