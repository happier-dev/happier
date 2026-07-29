import type { Message } from '@/sync/domains/messages/messageTypes';
import { compareTranscriptMessagesOldestFirst, hasTranscriptMessageOrderChanged } from '@/sync/domains/messages/transcriptOrdering';
import {
    collectTranscriptRequestStates,
    mergeTranscriptRequestState,
    type TranscriptRequestState,
} from '@/sync/domains/session/pending/listPendingSessionRequests';

import {
    createSessionListReadableActivityAccumulator,
    foldSessionListReadableActivityMessage,
} from './sessionListReadableActivity';

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
     * Max normalized `seq` over messages whose attention impact affects unread
     * state (`SessionListReadableActivitySummary.latestCommittedMessageSeq`).
     */
    latestCommittedMessageSeq: number | null;
    /**
     * Max normalized `createdAt` over messages whose attention impact affects
     * meaningful activity (feeds `deriveSessionListMeaningfulActivityAt`).
     */
    latestCommittedMessageCreatedAt: number | null;
    /**
     * The transcript's first `user-text` message (oldest-first order), backing
     * the transient session-title fallback for sessions without a display
     * title. `null` when the transcript has no user text.
     */
    firstUserTextMessage: Message | null;
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

function readableActivityContribution(message: Message): {
    latestCommittedMessageSeq: number | null;
    latestCommittedMessageCreatedAt: number | null;
} {
    const accumulator = createSessionListReadableActivityAccumulator();
    foldSessionListReadableActivityMessage(accumulator, message);
    return accumulator;
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

function isUserTextMessage(message: Message | null): boolean {
    return message?.kind === 'user-text';
}

export function buildTranscriptRenderableAggregate(params: Readonly<{
    messages: ReadonlyArray<Message>;
    completedRequests: CompletedRequests;
}>): TranscriptRenderableAggregate {
    const readableActivity = createSessionListReadableActivityAccumulator();
    let firstUserTextMessage: Message | null = null;
    for (const message of params.messages) {
        foldSessionListReadableActivityMessage(readableActivity, message);
        if (firstUserTextMessage === null && isUserTextMessage(message)) {
            firstUserTextMessage = message;
        }
    }

    const requestStates = new Map<string, TranscriptRequestState>();
    collectTranscriptRequestStates(params.messages, params.completedRequests, requestStates);

    return {
        latestCommittedMessageSeq: readableActivity.latestCommittedMessageSeq,
        latestCommittedMessageCreatedAt: readableActivity.latestCommittedMessageCreatedAt,
        firstUserTextMessage,
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

    // Readable-activity watermarks (max normalized seq / createdAt).
    const previousContribution = previous ? readableActivityContribution(previous) : null;
    const nextContribution = readableActivityContribution(next);

    const previousSeq = previousContribution?.latestCommittedMessageSeq ?? null;
    const nextSeq = nextContribution.latestCommittedMessageSeq;
    if (previousSeq !== null && (nextSeq === null || nextSeq < previousSeq)) {
        // The contribution weakened. If it could have been the max, the true
        // max may decrease — only a full rebuild can answer that.
        if (aggregate.latestCommittedMessageSeq !== null
            && previousSeq >= aggregate.latestCommittedMessageSeq) {
            return false;
        }
    } else if (nextSeq !== null) {
        aggregate.latestCommittedMessageSeq = aggregate.latestCommittedMessageSeq === null
            ? nextSeq
            : Math.max(aggregate.latestCommittedMessageSeq, nextSeq);
    }

    const previousCreatedAt = previousContribution?.latestCommittedMessageCreatedAt ?? null;
    const nextCreatedAt = nextContribution.latestCommittedMessageCreatedAt;
    if (previousCreatedAt !== null && (nextCreatedAt === null || nextCreatedAt < previousCreatedAt)) {
        if (aggregate.latestCommittedMessageCreatedAt !== null
            && previousCreatedAt >= aggregate.latestCommittedMessageCreatedAt) {
            return false;
        }
    } else if (nextCreatedAt !== null) {
        aggregate.latestCommittedMessageCreatedAt = aggregate.latestCommittedMessageCreatedAt === null
            ? nextCreatedAt
            : Math.max(aggregate.latestCommittedMessageCreatedAt, nextCreatedAt);
    }

    // First user-text (transient title fallback source).
    if (aggregate.firstUserTextMessage !== null && previous?.id === aggregate.firstUserTextMessage.id) {
        if (!isUserTextMessage(next) || hasTranscriptMessageOrderChanged(previous, next)) {
            // The tracked first user text disappeared or moved; the true first
            // user text is unknowable without a full walk.
            return false;
        }
        aggregate.firstUserTextMessage = next;
    } else if (isUserTextMessage(next)) {
        if (
            aggregate.firstUserTextMessage === null
            || compareTranscriptMessagesOldestFirst(next, aggregate.firstUserTextMessage) < 0
        ) {
            aggregate.firstUserTextMessage = next;
        }
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

export function canReuseTranscriptRenderableAggregateRequestStates(
    aggregate: TranscriptRenderableAggregate,
    completedRequests: CompletedRequests,
): boolean {
    return aggregate.completedRequestsRef === completedRequests;
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
