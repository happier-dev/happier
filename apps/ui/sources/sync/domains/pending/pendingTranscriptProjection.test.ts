import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';

import {
    collectCommittedTranscriptLocalIds,
    filterCommittedTranscriptMessageIdsForPendingState,
    isCommittedTranscriptMessageHiddenByCrossover,
    isPendingTranscriptMessageHiddenByCrossover,
    resolveCommittedTranscriptSeqHighWaterMark,
    resolvePendingTranscriptCrossover,
} from './pendingTranscriptProjection';

function pendingRecord(overrides: Partial<PendingMessage> = {}): PendingMessage {
    return {
        id: 'p1',
        localId: 'l1',
        createdAt: 1,
        updatedAt: 1,
        source: 'local_outbound',
        text: 'hello',
        rawRecord: null,
        ...overrides,
    } as PendingMessage;
}

function committedUserMessage(localId: string | null): Message {
    return { kind: 'user-text', id: `m-${localId ?? 'none'}`, localId, createdAt: 2, text: 'hello' } as Message;
}

/**
 * The crossover owns ONE decision for two rows describing one utterance. `sync/store/domains/
 * messages.ts` already drops the matching non-durable pending records in the SAME store update that
 * appends the committed messages, so the handover is a single commit; what this module has to
 * guarantee is that, in every frame, exactly one of the two rows is visible.
 */
describe('pending → committed crossover', () => {
    function visibleRows(params: Readonly<{
        pendingMessages: PendingMessage[];
        discardedMessages?: DiscardedPendingMessage[];
        committed: Message[];
    }>) {
        const messagesById = Object.fromEntries(params.committed.map((message) => [message.id, message]));
        const crossover = resolvePendingTranscriptCrossover({
            committedLocalIds: collectCommittedTranscriptLocalIds(Object.keys(messagesById), messagesById),
            pendingMessages: params.pendingMessages,
            discardedMessages: params.discardedMessages,
        });
        return {
            committed: params.committed.filter((message) => !isCommittedTranscriptMessageHiddenByCrossover(message, crossover)),
            pending: params.pendingMessages.filter((message) => !isPendingTranscriptMessageHiddenByCrossover(message, crossover)),
        };
    }

    it('keeps exactly one row per utterance across the whole local send handover', () => {
        const pending = pendingRecord({ localId: 'l1' });
        const committed = committedUserMessage('l1');

        // 1. queued only.
        const queued = visibleRows({ pendingMessages: [pending], committed: [] });
        expect(queued.pending).toHaveLength(1);
        expect(queued.committed).toHaveLength(0);

        // 2. the one frame where both records can be observed together.
        const overlap = visibleRows({ pendingMessages: [pending], committed: [committed] });
        expect(overlap.pending).toHaveLength(0);
        expect(overlap.committed).toHaveLength(1);

        // 3. committed only (the store removed the pending record in the same update).
        const settled = visibleRows({ pendingMessages: [], committed: [committed] });
        expect(settled.committed).toHaveLength(1);
    });

    it('lets a durable server pending row keep the slot and hides its committed twin', () => {
        const durable = pendingRecord({ localId: 'l1', source: 'server_pending' });
        const rows = visibleRows({ pendingMessages: [durable], committed: [committedUserMessage('l1')] });

        expect(rows.pending).toHaveLength(1);
        expect(rows.committed).toHaveLength(0);
    });

    it('resolves a durable and a local record for one utterance to a single visible row', () => {
        const rows = visibleRows({
            pendingMessages: [
                pendingRecord({ id: 'p-local', localId: 'l1', source: 'local_outbound' }),
                pendingRecord({ id: 'p-durable', localId: 'l1', source: 'server_pending' }),
            ],
            committed: [committedUserMessage('l1')],
        });

        expect(rows.pending.map((message) => message.id)).toEqual(['p-durable']);
        expect(rows.committed).toHaveLength(0);
    });

    it('never hides a pending row whose utterance has no committed twin', () => {
        const rows = visibleRows({
            pendingMessages: [pendingRecord({ localId: 'l1' })],
            committed: [committedUserMessage('other')],
        });

        expect(rows.pending).toHaveLength(1);
        expect(rows.committed).toHaveLength(1);
    });

    it('leaves rows without a localId alone on both sides', () => {
        const rows = visibleRows({
            pendingMessages: [pendingRecord({ localId: null })],
            committed: [committedUserMessage(null)],
        });

        expect(rows.pending).toHaveLength(1);
        expect(rows.committed).toHaveLength(1);
    });

    it('hides a committed row for a durable record that is already discarded (its discarded row shows)', () => {
        const messages = [committedUserMessage('l1'), committedUserMessage('l2')];
        const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));

        const remaining = filterCommittedTranscriptMessageIdsForPendingState({
            messageIdsOldestFirst: messages.map((message) => message.id),
            messagesById,
            pendingMessages: [],
            discardedMessages: [{
                ...pendingRecord({ localId: 'l1', source: 'server_pending' }),
                discardedAt: 3,
                discardedReason: 'manual',
            } as DiscardedPendingMessage],
        });

        expect(remaining).toEqual([messages[1]!.id]);
    });
});

/**
 * The SEQUENCE BASIS the pending fence reads (`sync/engine/pending/pendingQueueV2.ts`'s
 * `withholdPendingRowsCommittedAfterSnapshotCapture`): a mark for "everything I could already have
 * observed", and a bounded walk for "committed above that mark". Withholding a row the mark cannot
 * prove is newer hides a live queued/blocked message, so both halves are pinned here at the owner
 * rather than only through the fence that consumes them.
 */
describe('committed transcript sequence basis', () => {
    function sequenced(params: Readonly<{ localId: string; seq?: number }>): Message {
        return {
            kind: 'user-text',
            id: `m-${params.localId}`,
            localId: params.localId,
            createdAt: 2,
            text: 'hello',
            ...(params.seq === undefined ? {} : { seq: params.seq }),
        } as Message;
    }

    function transcript(messages: readonly Message[]) {
        return {
            messageIdsOldestFirst: messages.map((message) => message.id),
            messagesById: Object.fromEntries(messages.map((message) => [message.id, message])),
        };
    }

    describe('resolveCommittedTranscriptSeqHighWaterMark', () => {
        it('has no basis until the session is loaded and a loaded message carries a seq', () => {
            const empty = { messageIdsOldestFirst: [], messagesById: {} };

            // Not loaded at all: the ordinary session-open state.
            expect(resolveCommittedTranscriptSeqHighWaterMark({ isLoaded: false, sessionSeq: 12, ...empty })).toBeNull();
            // Not loaded, yet a seq-bearing page is ALREADY in the store: the ordinary
            // initial-page window. `sync/store/domains/messages.ts` creates a session's message
            // entry with `isLoaded: false` and every apply PRESERVES that flag, while
            // `sync/engine/sessions/syncSessions.ts` calls `markMessagesLoaded` only after the
            // initial page has been applied — so a partially paged transcript carrying real seqs
            // coexists with `isLoaded: false`. A page whose completeness the client cannot vouch
            // for is not a basis: without the loaded term this reads 9 off it and withholds every
            // twin sequenced at or below 9 — old news it simply has not paged in yet — which hides
            // a live queued/blocked row.
            expect(resolveCommittedTranscriptSeqHighWaterMark({
                isLoaded: false,
                sessionSeq: 2,
                ...transcript([sequenced({ localId: 'l1', seq: 9 })]),
            })).toBeNull();
            // Marked loaded over an EMPTY transcript: a completed attempt is not knowledge, and
            // `session.seq` is rehydrated from the warm cache without any message cache behind it,
            // so it may sit arbitrarily below the server's real tail.
            expect(resolveCommittedTranscriptSeqHighWaterMark({ isLoaded: true, sessionSeq: 0, ...empty })).toBeNull();
            expect(resolveCommittedTranscriptSeqHighWaterMark({ isLoaded: true, sessionSeq: 12, ...empty })).toBeNull();
            // Loaded messages that carry no seq cannot bound anything either.
            expect(resolveCommittedTranscriptSeqHighWaterMark({
                isLoaded: true,
                sessionSeq: 12,
                ...transcript([sequenced({ localId: 'l1' })]),
            })).toBeNull();
        });

        it('takes the highest of the loaded seqs and the session seq once a basis exists', () => {
            const loaded = transcript([
                sequenced({ localId: 'l1', seq: 4 }),
                sequenced({ localId: 'l2' }),
                sequenced({ localId: 'l3', seq: 9 }),
                sequenced({ localId: 'l4', seq: 7 }),
            ]);

            // A stale-low (or absent) session seq must not lower the mark below what is loaded…
            expect(resolveCommittedTranscriptSeqHighWaterMark({ isLoaded: true, sessionSeq: 2, ...loaded })).toBe(9);
            expect(resolveCommittedTranscriptSeqHighWaterMark({ isLoaded: true, sessionSeq: null, ...loaded })).toBe(9);
            expect(resolveCommittedTranscriptSeqHighWaterMark({ isLoaded: true, sessionSeq: undefined, ...loaded })).toBe(9);
            // …and a session seq the socket advanced past the loaded page must raise it, because a
            // higher mark can only ever withhold less.
            expect(resolveCommittedTranscriptSeqHighWaterMark({ isLoaded: true, sessionSeq: 21, ...loaded })).toBe(21);
        });
    });

    describe('collectCommittedTranscriptLocalIds', () => {
        const messages = [
            sequenced({ localId: 'below', seq: 5 }),
            sequenced({ localId: 'at', seq: 6 }),
            sequenced({ localId: 'above', seq: 7 }),
            sequenced({ localId: 'unsequenced' }),
        ];

        it('bounds by aboveSeq strictly and drops what it cannot prove is newer', () => {
            const localIds = collectCommittedTranscriptLocalIds(
                messages.map((message) => message.id),
                Object.fromEntries(messages.map((message) => [message.id, message])),
                { aboveSeq: 6 },
            );

            // Strictly above: a message AT the mark is old news the client could already have seen,
            // and a message with no seq cannot be proven newer — withholding on either hides a row.
            expect([...localIds]).toEqual(['above']);
        });

        it('keeps every localId, seq or not, when no bound is asked for', () => {
            const localIds = collectCommittedTranscriptLocalIds(
                messages.map((message) => message.id),
                Object.fromEntries(messages.map((message) => [message.id, message])),
            );

            expect([...localIds].sort()).toEqual(['above', 'at', 'below', 'unsequenced']);
        });
    });
});
