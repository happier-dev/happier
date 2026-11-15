import {
    collectTranscriptRequestStates,
    mergeTranscriptRequestState,
    type TranscriptRequestState,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import { resolveLatestUnreadAffectingCommittedMessageSeq } from '@/sync/domains/session/readCursor/resolveSessionReadableSeq';

import { messageAttentionImpact } from './messageUserAttention';
import type { Message } from './messageTypes';

/**
 * Incrementally-maintained per-session transcript aggregates that back the
 * session-list renderable derivation (`buildSessionListRenderableFromSession`).
 *
 * The full transcript walk lives ONLY in `buildTranscriptRenderableAggregate`
 * (cold start / fallback). On the streaming hot path the store applies each
 * changed message through `applyMessageChangeToTranscriptRenderableAggregate`,
 * which costs O(changed messages) instead of O(transcript length).
 *
 * OWNERSHIP / MUTABILITY: like `SessionMessages.reducerState`, an aggregate is
 * mutated in place by its owning store entry. Do not rely on its referential
 * identity to detect changes, and never share it outside the derivation pass
 * that the store runs synchronously.
 */
export type TranscriptRenderableAggregate = {
    /**
     * Max `createdAt` over messages whose attention impact affects meaningful
     * activity (feeds `deriveSessionListMeaningfulActivityAt`).
     */
    latestCommittedMessageCreatedAt: number | null;
    /**
     * Max normalized `seq` over messages whose attention impact affects unread
     * state (feeds `resolveSessionReadableSeq`).
     */
    latestUnreadAffectingMessageSeq: number | null;
    /** Number of transcript messages folded into the aggregate. */
    messageCount: number;
    /** Canonical transcript request states keyed by request id. */
    requestStates: Map<string, TranscriptRequestState>;
    /**
     * Identity of the `agentState.completedRequests` record the request states
     * were folded with. When it changes, `requestStates` must be rebuilt
     * (pending coverage depends on it) — see
     * `canReuseTranscriptRenderableAggregateRequestStates`.
     */
    completedRequestsRef: Record<string, unknown> | null;
};

type CompletedRequests = Record<string, unknown> | null;

function latestMeaningfulActivityCreatedAtContribution(message: Message): number | null {
    if (!messageAttentionImpact(message).affectsMeaningfulActivity) return null;
    const createdAt = message.createdAt;
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) return null;
    return createdAt;
}

function collectMessageRequestStates(
    message: Message,
    completedRequests: CompletedRequests,
): Map<string, TranscriptRequestState> {
    const states = new Map<string, TranscriptRequestState>();
    collectTranscriptRequestStates([message], completedRequests, states);
    return states;
}

function messageMayContributeRequestStates(message: Message | null): boolean {
    return message?.kind === 'tool-call';
}

export function buildTranscriptRenderableAggregate(params: Readonly<{
    messages: ReadonlyArray<Message>;
    completedRequests: CompletedRequests;
}>): TranscriptRenderableAggregate {
    let latestCommittedMessageCreatedAt: number | null = null;
    for (const message of params.messages) {
        const contribution = latestMeaningfulActivityCreatedAtContribution(message);
        if (contribution === null) continue;
        latestCommittedMessageCreatedAt = latestCommittedMessageCreatedAt === null
            ? contribution
            : Math.max(latestCommittedMessageCreatedAt, contribution);
    }

    const requestStates = new Map<string, TranscriptRequestState>();
    collectTranscriptRequestStates(params.messages, params.completedRequests, requestStates);

    return {
        latestCommittedMessageCreatedAt,
        latestUnreadAffectingMessageSeq: resolveLatestUnreadAffectingCommittedMessageSeq(params.messages),
        messageCount: params.messages.length,
        requestStates,
        completedRequestsRef: params.completedRequests,
    };
}

function areTerminalStatesInterchangeable(
    previous: TranscriptRequestState,
    next: TranscriptRequestState,
): boolean {
    return previous.status === 'terminal'
        && next.status === 'terminal'
        && previous.createdAt === next.createdAt
        && previous.terminalKind === next.terminalKind;
}

/**
 * Applies one changed message to the aggregate in place.
 *
 * Returns `false` when the change is not expressible as a monotone update
 * (a contribution weakened or disappeared); the caller MUST then discard the
 * aggregate — it may have been partially mutated — and rebuild it via
 * `buildTranscriptRenderableAggregate` before its next use.
 */
export function applyMessageChangeToTranscriptRenderableAggregate(params: Readonly<{
    aggregate: TranscriptRenderableAggregate;
    previous: Message | null;
    next: Message;
}>): boolean {
    const { aggregate, previous, next } = params;

    if (previous === null) {
        aggregate.messageCount += 1;
    }

    // Meaningful-activity watermark (max createdAt).
    const previousCreatedAt = previous ? latestMeaningfulActivityCreatedAtContribution(previous) : null;
    const nextCreatedAt = latestMeaningfulActivityCreatedAtContribution(next);
    if (previousCreatedAt !== null && (nextCreatedAt === null || nextCreatedAt < previousCreatedAt)) {
        // The contribution weakened. If it could have been the max, the true
        // max may decrease — only a full rebuild can answer that.
        if (aggregate.latestCommittedMessageCreatedAt !== null
            && previousCreatedAt >= aggregate.latestCommittedMessageCreatedAt) {
            return false;
        }
    } else if (nextCreatedAt !== null) {
        aggregate.latestCommittedMessageCreatedAt = aggregate.latestCommittedMessageCreatedAt === null
            ? nextCreatedAt
            : Math.max(aggregate.latestCommittedMessageCreatedAt, nextCreatedAt);
    }

    // Unread watermark (max normalized seq).
    const previousSeq = previous ? resolveLatestUnreadAffectingCommittedMessageSeq([previous]) : null;
    const nextSeq = resolveLatestUnreadAffectingCommittedMessageSeq([next]);
    if (previousSeq !== null && (nextSeq === null || nextSeq < previousSeq)) {
        if (aggregate.latestUnreadAffectingMessageSeq !== null
            && previousSeq >= aggregate.latestUnreadAffectingMessageSeq) {
            return false;
        }
    } else if (nextSeq !== null) {
        aggregate.latestUnreadAffectingMessageSeq = aggregate.latestUnreadAffectingMessageSeq === null
            ? nextSeq
            : Math.max(aggregate.latestUnreadAffectingMessageSeq, nextSeq);
    }

    // Transcript request states.
    if (!messageMayContributeRequestStates(previous) && !messageMayContributeRequestStates(next)) {
        return true;
    }
    const previousStates = previous
        ? collectMessageRequestStates(previous, aggregate.completedRequestsRef)
        : null;
    const nextStates = collectMessageRequestStates(next, aggregate.completedRequestsRef);

    if (previousStates) {
        for (const [requestId, previousState] of previousStates) {
            const nextState = nextStates.get(requestId);
            if (!nextState) {
                // The message stopped contributing this request id; the merged
                // map cannot un-learn it, so a full rebuild is required.
                return false;
            }
            if (
                mergeTranscriptRequestState(previousState, nextState) !== nextState
                && !areTerminalStatesInterchangeable(previousState, nextState)
            ) {
                // The new contribution would lose the merge against the old
                // one — a non-monotone downgrade the merge cannot express.
                return false;
            }
        }
    }

    for (const [requestId, nextState] of nextStates) {
        aggregate.requestStates.set(
            requestId,
            mergeTranscriptRequestState(aggregate.requestStates.get(requestId), nextState),
        );
    }

    return true;
}

export { canReuseTranscriptRenderableAggregateRequestStates } from './transcriptRenderableAggregateReuse';

export function isTranscriptRenderableAggregate(value: unknown): value is TranscriptRenderableAggregate {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<TranscriptRenderableAggregate>;
    return candidate.requestStates instanceof Map
        && typeof candidate.messageCount === 'number'
        && Number.isFinite(candidate.messageCount)
        && (candidate.latestCommittedMessageCreatedAt === null || typeof candidate.latestCommittedMessageCreatedAt === 'number')
        && (candidate.latestUnreadAffectingMessageSeq === null || typeof candidate.latestUnreadAffectingMessageSeq === 'number')
        && 'completedRequestsRef' in candidate;
}
