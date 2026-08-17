import type { Message } from '@/sync/domains/messages/messageTypes';
import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';

export function shouldPreservePendingProjectionAfterCommittedUserLocalId(
    message: Pick<PendingMessage, 'source'>,
): boolean {
    return message.source === 'server_pending';
}

/**
 * The pending → committed CROSSOVER, resolved once.
 *
 * One user utterance can be described by two rows at the same tail slot: the `pending-queue` row
 * (from `sessionPending.messages` / `discardedMessages`) and, after it commits, the `msg:<id>` row.
 * Exactly one of them may be visible at a time, in every frame:
 *
 *   - `pendingOwnedLocalIds` — a DURABLE (server) pending record still owns the slot, so the
 *     committed twin is suppressed. Only `source: 'server_pending'` rows qualify; the server owns
 *     their removal, so the pending row must survive until it does.
 *   - otherwise the committed row owns the slot and every pending record for that localId is
 *     suppressed.
 *
 * Proof that neither side can vanish and neither can double, for a localId `L` with a committed row:
 *   - `L ∈ pendingOwnedLocalIds` ⇒ a durable record for `L` exists, and
 *     {@link isPendingTranscriptMessageHiddenByCrossover} returns `false` for it ⇒ that row shows,
 *     the committed row hides. One row.
 *   - `L ∉ pendingOwnedLocalIds` ⇒ the committed row shows, and every (non-durable) pending record
 *     for `L` hides. One row.
 * The two readers below are the ONLY consumers of that decision, and they read the SAME resolved
 * sets — previously the committed side keyed on a `server_pending`-derived set while the pending
 * side keyed on a separately built transcript-localId set, which is two decision-makers over one
 * handover.
 *
 * ATOMICITY (2026-07-30): the handover is already a single commit and this projection is not where
 * that is decided. `sync/store/domains/messages.ts` removes the matching non-durable pending records
 * in the SAME store update that appends the committed messages, so a subscriber never observes a
 * frame with neither row (nor one with both). This module only has to keep the durable-pending case
 * consistent with that, which is what the invariant above states.
 */
export type PendingTranscriptCrossover = Readonly<{
    /** localIds whose transcript slot is still owned by a durable (server) pending row. */
    pendingOwnedLocalIds: ReadonlySet<string>;
    /** localIds that already have a committed transcript row available to own the slot. */
    committedLocalIds: ReadonlySet<string>;
}>;

export function resolvePendingTranscriptCrossover(params: Readonly<{
    /**
     * localIds of the committed messages this transcript renders. In `turns` grouping mode the
     * committed rows are emitted by the turn builder rather than by `buildChatListItems`, so this
     * is the localId set of the transcript's messages — not of one builder's output.
     */
    committedLocalIds: ReadonlySet<string>;
    pendingMessages?: readonly PendingMessage[] | null;
    discardedMessages?: readonly DiscardedPendingMessage[] | null;
}>): PendingTranscriptCrossover {
    const pendingOwnedLocalIds = new Set<string>();
    const claim = (message: Pick<PendingMessage, 'localId' | 'source'>) => {
        if (!shouldPreservePendingProjectionAfterCommittedUserLocalId(message)) return;
        if (message.localId) pendingOwnedLocalIds.add(message.localId);
    };
    if (Array.isArray(params.pendingMessages)) {
        for (const message of params.pendingMessages) claim(message);
    }
    if (Array.isArray(params.discardedMessages)) {
        for (const message of params.discardedMessages) claim(message);
    }
    return {
        pendingOwnedLocalIds,
        committedLocalIds: params.committedLocalIds,
    };
}

export function isCommittedTranscriptMessageHiddenByCrossover(
    message: Message,
    crossover: PendingTranscriptCrossover,
): boolean {
    if (crossover.pendingOwnedLocalIds.size === 0) return false;
    const localId = 'localId' in message ? message.localId : null;
    return Boolean(localId) && crossover.pendingOwnedLocalIds.has(localId!);
}

export function isPendingTranscriptMessageHiddenByCrossover(
    message: Pick<PendingMessage, 'localId' | 'source'>,
    crossover: PendingTranscriptCrossover,
): boolean {
    const localId = message.localId;
    if (!localId || !crossover.committedLocalIds.has(localId)) return false;
    return !shouldPreservePendingProjectionAfterCommittedUserLocalId(message);
}

/**
 * The committed transcript localIds, optionally restricted to messages the server sequenced ABOVE a
 * high-water mark.
 *
 * `seq` is the server's own monotone per-session message counter, shared by `Session.seq` and
 * `SessionMessage.seq`, so `aboveSeq` reads as "committed later than everything this client could
 * already have observed at that mark". A message without a numeric `seq` cannot be proven newer and
 * is therefore excluded from a bounded collection (never from an unbounded one).
 */
export function collectCommittedTranscriptLocalIds(
    messageIdsOldestFirst: readonly string[],
    messagesById: Readonly<Record<string, Message>>,
    options?: Readonly<{ aboveSeq: number }>,
): Set<string> {
    const aboveSeq = options?.aboveSeq;
    const localIds = new Set<string>();
    for (const messageId of messageIdsOldestFirst) {
        const message = messagesById[messageId];
        if (!message) continue;
        if (aboveSeq !== undefined && !(typeof message.seq === 'number' && message.seq > aboveSeq)) continue;
        if ('localId' in message && message.localId) localIds.add(message.localId);
    }
    return localIds;
}

/**
 * The highest session sequence this client could already have observed for a session, or `null`
 * when it holds no basis for that judgement.
 *
 * `null` is ABSENCE OF BASIS, not emptiness: a client that holds no committed message cannot tell
 * "this commit is newer than my read" from "I had simply not loaded this commit yet", and the safe
 * answer for that state is to assert nothing.
 *
 * The basis is a LOADED COMMITTED MESSAGE carrying a numeric `seq`, not the `isLoaded` flag and not
 * `session.seq`:
 *
 *   - `isLoaded` can be `true` over an EMPTY transcript — `sync/sync.ts`'s `fetchMessages` marks a
 *     session loaded and returns without applying anything when it cannot resolve the session to the
 *     active or a locally known owner server, and `sync/engine/sessions/syncSessions.ts` calls
 *     `markMessagesLoaded` after an empty initial page — so the flag reports a completed attempt,
 *     not knowledge.
 *   - `session.seq` alone cannot carry the mark either: `sync/domains/state/warmCacheAdapters.ts`
 *     persists and rehydrates it while caching NEITHER `sessionMessages` nor `sessionPending`, so on
 *     a warm start it can be arbitrarily stale-low, and every commit above it — including a durable
 *     twin that is old news — would read as newer than the read.
 *
 * It is still included once a basis exists, because it can be ahead of the loaded page (the socket
 * advances it on `new-message`) and a HIGHER mark can only ever withhold LESS.
 */
export function resolveCommittedTranscriptSeqHighWaterMark(params: Readonly<{
    isLoaded: boolean;
    sessionSeq: number | null | undefined;
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}>): number | null {
    if (!params.isLoaded) return null;
    let highWaterMark: number | null = null;
    for (const messageId of params.messageIdsOldestFirst) {
        const seq = params.messagesById[messageId]?.seq;
        if (typeof seq !== 'number' || !Number.isFinite(seq)) continue;
        if (highWaterMark === null || seq > highWaterMark) highWaterMark = seq;
    }
    if (highWaterMark === null) return null;
    const sessionSeq = params.sessionSeq;
    if (typeof sessionSeq === 'number' && Number.isFinite(sessionSeq) && sessionSeq > highWaterMark) {
        return sessionSeq;
    }
    return highWaterMark;
}

export function filterCommittedTranscriptMessageIdsForPendingState(params: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    pendingMessages?: readonly PendingMessage[] | null;
    discardedMessages?: readonly DiscardedPendingMessage[] | null;
}>): string[] {
    const crossover = resolvePendingTranscriptCrossover({
        committedLocalIds: collectCommittedTranscriptLocalIds(params.messageIdsOldestFirst, params.messagesById),
        pendingMessages: params.pendingMessages,
        discardedMessages: params.discardedMessages,
    });
    if (crossover.pendingOwnedLocalIds.size === 0) return [...params.messageIdsOldestFirst];
    return params.messageIdsOldestFirst.filter((messageId) => {
        const message = params.messagesById[messageId];
        return !message || !isCommittedTranscriptMessageHiddenByCrossover(message, crossover);
    });
}
