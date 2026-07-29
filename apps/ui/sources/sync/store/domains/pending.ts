import type { Message } from '../../domains/messages/messageTypes';
import { isRecoveredHistoryTranscriptObservation } from '../../domains/messages/transcriptObservationProvenance';
import type { DiscardedPendingMessage, PendingMessage } from '../../domains/state/storageTypes';
import { shouldPreservePendingProjectionAfterCommittedUserLocalId } from '../../domains/pending/pendingTranscriptProjection';

import type { StoreGet, StoreSet } from './_shared';

export type SessionPending = {
    messages: PendingMessage[];
    discarded: DiscardedPendingMessage[];
    isLoaded: boolean;
};

export type PendingDomain = {
    sessionPending: Record<string, SessionPending>;
    applyPendingLoaded: (sessionId: string) => void;
    applyPendingSnapshot: (sessionId: string, snapshot: Readonly<{
        messages: PendingMessage[];
        discarded: DiscardedPendingMessage[];
    }>) => void;
    applyPendingMessages: (sessionId: string, messages: PendingMessage[]) => void;
    applyDiscardedPendingMessages: (sessionId: string, messages: DiscardedPendingMessage[]) => void;
    pruneServerPendingMessages: (sessionId: string) => void;
    upsertPendingMessage: (sessionId: string, message: PendingMessage) => void;
    removePendingMessage: (sessionId: string, pendingId: string) => void;
};

type PendingDomainDependencies = {
    sessionMessages?: Record<string, {
        messagesById?: Record<string, Message>;
        messagesMap?: Record<string, Message>;
    } | undefined>;
};

function collectCommittedUserLocalIds<S extends PendingDomainDependencies>(
    state: S,
    sessionId: string,
    candidateLocalIds: ReadonlySet<string>,
): Set<string> {
    if (candidateLocalIds.size === 0) return new Set();

    const sessionMessages = state.sessionMessages?.[sessionId];
    const messagesById = sessionMessages?.messagesById ?? sessionMessages?.messagesMap;
    if (!messagesById) return new Set();

    const committed = new Set<string>();
    for (const message of Object.values(messagesById)) {
        if (
            message?.kind !== 'user-text'
            || isRecoveredHistoryTranscriptObservation(message)
        ) continue;
        const localId = typeof message.localId === 'string' ? message.localId : '';
        if (localId && candidateLocalIds.has(localId)) {
            committed.add(localId);
        }
    }
    return committed;
}

function filterUncommittedPendingMessages<S extends PendingDomainDependencies>(
    state: S,
    sessionId: string,
    messages: PendingMessage[],
): PendingMessage[] {
    const candidateLocalIds = new Set<string>();
    for (const message of messages) {
        if (message.localId) candidateLocalIds.add(message.localId);
    }

    const committedLocalIds = collectCommittedUserLocalIds(state, sessionId, candidateLocalIds);
    if (committedLocalIds.size === 0) return messages;

    return messages.filter((message) => (
        !message.localId
        || !committedLocalIds.has(message.localId)
        || shouldPreservePendingProjectionAfterCommittedUserLocalId(message)
    ));
}

function isPendingMessageAlreadyCommitted<S extends PendingDomainDependencies>(
    state: S,
    sessionId: string,
    message: PendingMessage,
): boolean {
    if (!message.localId) return false;
    if (shouldPreservePendingProjectionAfterCommittedUserLocalId(message)) return false;
    return collectCommittedUserLocalIds(state, sessionId, new Set([message.localId])).size > 0;
}

function arePendingValuesEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right)) return false;
        if (left.length !== right.length) return false;
        return left.every((value, index) => arePendingValuesEqual(value, right[index]));
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => (
        Object.prototype.hasOwnProperty.call(rightRecord, key)
        && arePendingValuesEqual(leftRecord[key], rightRecord[key])
    ));
}

function arePendingMessageListsEqual<T>(left: readonly T[], right: readonly T[]): boolean {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    return left.every((message, index) => arePendingValuesEqual(message, right[index]));
}

function replacePendingBucket<S extends PendingDomain & PendingDomainDependencies>(
    state: S,
    sessionId: string,
    snapshot: Readonly<{
        messages: PendingMessage[];
        discarded: DiscardedPendingMessage[];
        isLoaded: boolean;
    }>,
): S {
    const filteredMessages = filterUncommittedPendingMessages(state, sessionId, snapshot.messages);
    const existing = state.sessionPending[sessionId];
    const previousMessages = existing?.messages ?? [];
    const previousDiscarded = existing?.discarded ?? [];
    const nextMessages = arePendingMessageListsEqual(previousMessages, filteredMessages)
        ? previousMessages
        : filteredMessages;
    const nextDiscarded = arePendingMessageListsEqual(previousDiscarded, snapshot.discarded)
        ? previousDiscarded
        : snapshot.discarded;
    if (
        existing
        && nextMessages === previousMessages
        && nextDiscarded === previousDiscarded
        && existing.isLoaded === snapshot.isLoaded
    ) {
        return state;
    }
    return {
        ...state,
        sessionPending: {
            ...state.sessionPending,
            [sessionId]: {
                messages: nextMessages,
                discarded: nextDiscarded,
                isLoaded: snapshot.isLoaded,
            },
        },
    };
}

export function createPendingDomain<S extends PendingDomain & PendingDomainDependencies>({
    set,
    get: _get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): PendingDomain {
    return {
        sessionPending: {},
        applyPendingLoaded: (sessionId: string) => set((state) => {
            const existing = state.sessionPending[sessionId];
            if (existing?.isLoaded === true) return state;
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        messages: existing?.messages ?? [],
                        discarded: existing?.discarded ?? [],
                        isLoaded: true
                    }
                }
            };
        }),
        applyPendingSnapshot: (sessionId, snapshot) => set((state) => replacePendingBucket(state, sessionId, {
            ...snapshot,
            isLoaded: true,
        })),
        applyPendingMessages: (sessionId, messages) => set((state) => replacePendingBucket(state, sessionId, {
            messages,
            discarded: state.sessionPending[sessionId]?.discarded ?? [],
            isLoaded: true,
        })),
        applyDiscardedPendingMessages: (sessionId, discarded) => set((state) => replacePendingBucket(state, sessionId, {
            messages: state.sessionPending[sessionId]?.messages ?? [],
            discarded,
            isLoaded: state.sessionPending[sessionId]?.isLoaded ?? false,
        })),
        pruneServerPendingMessages: (sessionId: string) => set((state) => {
            const existing = state.sessionPending[sessionId];
            if (!existing || existing.messages.length === 0) return state;
            const nextMessages = existing.messages.filter((message) => {
                if (message.source === 'server_pending') return false;
                const acceptedOrdinaryServerProjection =
                    message.source === 'local_outbound'
                    && message.deliveryStatus === 'accepted'
                    && message.pendingOutboxOperation === undefined
                    && (
                        message.pendingDeliveryStatus === undefined
                        || message.pendingDeliveryStatus === 'server_queued'
                        || message.pendingDeliveryStatus === 'server_delivering'
                    );
                return !acceptedOrdinaryServerProjection;
            });
            if (nextMessages.length === existing.messages.length) return state;
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        ...existing,
                        messages: nextMessages,
                    },
                },
            };
        }),
        upsertPendingMessage: (sessionId: string, message: PendingMessage) => set((state) => {
            if (isPendingMessageAlreadyCommitted(state, sessionId, message)) {
                return state;
            }
            const existing = state.sessionPending[sessionId] ?? { messages: [], discarded: [], isLoaded: false };
            const idx = existing.messages.findIndex((m) => m.id === message.id);
            if (idx >= 0 && arePendingValuesEqual(existing.messages[idx], message)) {
                return state;
            }
            const next = idx >= 0
                ? [...existing.messages.slice(0, idx), message, ...existing.messages.slice(idx + 1)]
                : [...existing.messages, message];
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        messages: next,
                        discarded: existing.discarded,
                        isLoaded: existing.isLoaded
                    }
                }
            };
        }),
        removePendingMessage: (sessionId: string, pendingId: string) => set((state) => {
            const existing = state.sessionPending[sessionId];
            if (!existing) return state;
            if (!existing.messages.some((message) => message.id === pendingId)) return state;
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        ...existing,
                        messages: existing.messages.filter((m) => m.id !== pendingId)
                    }
                }
            };
        }),
    };
}
