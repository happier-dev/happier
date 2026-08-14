import type { Message } from '../../domains/messages/messageTypes';
import { isRecoveredHistoryTranscriptObservationProvenance } from '@happier-dev/protocol';
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
            || isRecoveredHistoryTranscriptObservationProvenance(message.transcriptObservationProvenance)
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

    return messages.filter((message) => {
        if (!message.localId || !committedLocalIds.has(message.localId)) return true;
        return shouldPreservePendingProjectionAfterCommittedUserLocalId(message);
    });
}

/**
 * The other half of {@link filterUncommittedPendingMessages}.
 *
 * That filter can drop a pending projection once its committed twin exists, but it can never add
 * the twin, so it only closes the "both rows" hole. This predicate closes the "neither row" hole:
 * a LOCALLY OWNED outbound projection the server has ACCEPTED is retired by the arrival of its
 * committed twin (`applyMessages` does that in one store update), never by server pending state,
 * which never owned it. Dropping it earlier publishes a transcript with neither row — a list one
 * row shorter than both the before and after states.
 *
 * "Locally owned" is the whole justification, so it is checked, not assumed:
 *
 *   - `pendingOutboxScope` present means the row is a DURABLE outbox projection, and that scope is
 *     how the server pending queue addresses it. The queue owns it, so server pending state is
 *     authoritative for it — including "discarded" and "absent". Retaining such a row overrides
 *     the authority that retires it and strands it until app restart.
 *   - `pendingDeliveryStatus` present means the server has already reported on this row's delivery
 *     (`sync/engine/pending/pendingQueueV2.ts#withPendingDeliveryState` maps it from a server
 *     pending row). The queue knows it, so the queue may retire it.
 *   - A direct send (`sync/sync.ts`, active-session RPC/socket accept) creates a projection with
 *     NEITHER, because the server pending queue never learns about it: a snapshot that omits it,
 *     or a `pending-changed` count of 0, says nothing about it.
 *   - `deliveryStatus` is deliberately NOT consulted. It records how far THIS device's send has
 *     got (absent before the ack, `accepted` after the runtime RPC, `queued` + `sendState:
 *     'unconfirmed'` after an ack timeout) — it says nothing about who owns the row, and the send
 *     spends real time in every one of those states on a cold session open. Requiring `accepted`
 *     made this rule disagree with the owner it is aligned to,
 *     `sync/engine/pending/pendingQueueV2.ts#reconcileServerPendingSnapshotWithLocalOutbound`
 *     (`preservedUnscopedLocalOutbound`), which preserves an unscoped `local_outbound` row the
 *     snapshot does not name regardless of `deliveryStatus`, and it disagreed with
 *     `pruneServerPendingMessages` below, which already keeps a not-yet-accepted local row.
 *
 * This is a retention rule about ownership, not a delay: the row leaves the moment its twin
 * EXISTS, and an owner-driven retirement (cancel, discard, delete, send failure) removes it
 * immediately through `removePendingMessage`, which retention cannot undo — retention only ever
 * re-publishes a row still present in the store's own bucket.
 */
function isLocallyOwnedUncommittedOutboundProjection<S extends PendingDomainDependencies>(
    state: S,
    sessionId: string,
    message: PendingMessage,
): boolean {
    if (message.source !== 'local_outbound') return false;
    if (message.pendingOutboxScope !== undefined) return false;
    if (message.pendingDeliveryStatus !== undefined) return false;
    const localId = message.localId ?? message.id;
    if (!localId) return false;
    return collectCommittedUserLocalIds(state, sessionId, new Set([localId])).size === 0;
}

/**
 * A bulk server write speaks for exactly the rows it names — queued AND discarded. Omitting the
 * discarded side made this a second, less-informed decision-maker over the preservation question
 * `sync/engine/pending/pendingQueueV2.ts#reconcileServerPendingSnapshotWithLocalOutbound` already
 * owns with `serverLocalIds` (queued ∪ discarded): the reconciler correctly dropped a discarded
 * row and this function re-added it on every snapshot.
 */
function retainLocallyOwnedOutboundProjections<S extends PendingDomain & PendingDomainDependencies>(
    state: S,
    sessionId: string,
    nextMessages: PendingMessage[],
    nextDiscarded: readonly DiscardedPendingMessage[],
): PendingMessage[] {
    const existing = state.sessionPending[sessionId]?.messages;
    if (!existing || existing.length === 0) return nextMessages;

    const serverKnownIds = new Set<string>();
    const serverKnownLocalIds = new Set<string>();
    for (const message of [...nextMessages, ...nextDiscarded]) {
        serverKnownIds.add(message.id);
        serverKnownLocalIds.add(message.localId ?? message.id);
    }
    const retained = existing.filter((message) => (
        !serverKnownIds.has(message.id)
        && !serverKnownLocalIds.has(message.localId ?? message.id)
        && isLocallyOwnedUncommittedOutboundProjection(state, sessionId, message)
    ));
    if (retained.length === 0) return nextMessages;
    return [...nextMessages, ...retained];
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

function arePendingValuesEqual(previous: unknown, next: unknown): boolean {
    if (Object.is(previous, next)) return true;
    if (previous == null || next == null) return previous === next;

    if (Array.isArray(previous) || Array.isArray(next)) {
        if (!Array.isArray(previous) || !Array.isArray(next)) return false;
        if (previous.length !== next.length) return false;
        for (let index = 0; index < previous.length; index += 1) {
            if (!arePendingValuesEqual(previous[index], next[index])) return false;
        }
        return true;
    }

    if (typeof previous === 'object' || typeof next === 'object') {
        if (typeof previous !== 'object' || typeof next !== 'object') return false;
        const previousRecord = previous as Record<string, unknown>;
        const nextRecord = next as Record<string, unknown>;
        const previousKeys = Object.keys(previousRecord);
        const nextKeys = Object.keys(nextRecord);
        if (previousKeys.length !== nextKeys.length) return false;
        for (const key of previousKeys) {
            if (!(key in nextRecord)) return false;
            if (!arePendingValuesEqual(previousRecord[key], nextRecord[key])) return false;
        }
        return true;
    }

    return false;
}

function arePendingMessageListsEqual<T extends PendingMessage>(
    previous: readonly T[],
    next: readonly T[],
): boolean {
    if (previous === next) return true;
    if (previous.length !== next.length) return false;
    for (let index = 0; index < previous.length; index += 1) {
        if (!arePendingValuesEqual(previous[index], next[index])) return false;
    }
    return true;
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
    const filteredMessages = retainLocallyOwnedOutboundProjections(
        state,
        sessionId,
        filterUncommittedPendingMessages(state, sessionId, snapshot.messages),
        snapshot.discarded,
    );
    const existing = state.sessionPending[sessionId];
    const nextMessages = existing && arePendingMessageListsEqual(existing.messages, filteredMessages)
        ? existing.messages
        : filteredMessages;
    const nextDiscarded = existing && arePendingMessageListsEqual(existing.discarded, snapshot.discarded)
        ? existing.discarded
        : snapshot.discarded;
    if (
        existing
        && existing.messages === nextMessages
        && existing.discarded === nextDiscarded
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
                // A LOCALLY OWNED accepted projection is retired by its committed twin, not by the
                // server's pending count, which never counted it. A durable outbox projection is
                // counted by that queue, so an empty queue does retire it.
                if (isLocallyOwnedUncommittedOutboundProjection(state, sessionId, message)) return true;
                const acceptedOrdinaryServerProjection =
                    message.source === 'local_outbound'
                    && message.deliveryStatus === 'accepted'
                    && message.pendingOutboxOperation === undefined
                    && message.pendingOutboxQuarantineReason === undefined
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
            const nextMessages = existing.messages.filter((m) => m.id !== pendingId);
            if (nextMessages.length === existing.messages.length) return state;
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        ...existing,
                        messages: nextMessages
                    }
                }
            };
        }),
    };
}
