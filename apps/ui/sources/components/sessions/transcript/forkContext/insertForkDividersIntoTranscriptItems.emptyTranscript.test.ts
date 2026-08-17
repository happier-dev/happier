import { describe, expect, it } from 'vitest';

import type { ChatListItem } from '@/components/sessions/chatListItems';
import type { ForkedTranscriptSnapshot } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';
import { insertForkDividersIntoTranscriptItems } from './insertForkDividersIntoTranscriptItems';

/**
 * A fork boundary divider is CHROME for content: it labels the seam between an ancestor
 * segment and its child. When nothing has hydrated yet there is no seam to label, and
 * emitting the divider anyway publishes a NON-EMPTY transcript before a single message
 * exists.
 *
 * That is not cosmetic. Measured live on web (session `cms4aenky5lnktm72sfmya6uk`, cold
 * direct route load, 2026-07-30): the first published item list was `[fork-divider]`
 * alone (1 mounted row, scrollHeight 324px). Legend therefore completed its initial-scroll
 * bootstrap and flipped its row container from `opacity: 0` to `opacity: 1` against that
 * placeholder, so EVERY later hydration wave (317 -> 2291 -> 2253 -> 12241px) happened in
 * front of the reader, including eight `scrollToIndex` targets that collapsed to
 * `scrollTop: 0` and a 1.43s hold with the divider parked at the top of the viewport.
 * The unforked control session (`cms2xm9iv5i0ytmgzuzs9by4y`, same cold path) published an
 * EMPTY list until its content arrived, stayed at `opacity: 0` through placement, and
 * revealed once, already at the tail.
 *
 * The contract this pins: dividers accompany content. An item list with no content rows
 * yields no dividers, so a forked transcript stays as empty as an unforked one until its
 * first real row lands.
 *
 * This does not weaken the established empty-DESCENDANT-segment behaviour
 * (`insertForkDividersIntoTranscriptItems.test.ts`): those cases all carry at least one
 * content row and keep their dividers.
 */
describe('insertForkDividersIntoTranscriptItems — nothing hydrated yet', () => {
    const fork: ForkedTranscriptSnapshot = {
        segments: [
            { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 2, messageIdsOldestFirst: [] },
            { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null, messageIdsOldestFirst: [] },
        ],
        combinedMessageIdsOldestFirst: [],
        combinedMessagesById: {},
        messageOriginById: {},
        isLoaded: false,
    };

    it('publishes no rows at all while the forked transcript has no content', () => {
        const result = insertForkDividersIntoTranscriptItems({ items: [] as ChatListItem[], fork });

        expect(result.map((item) => item.kind)).toEqual([]);
    });

    it('publishes no rows for a multi-level fork chain with no content', () => {
        const chain: ForkedTranscriptSnapshot = {
            ...fork,
            segments: [
                { sessionId: 'A', isReadOnlyContext: true, cutoffSeqInclusive: 2, messageIdsOldestFirst: [] },
                { sessionId: 'B', isReadOnlyContext: true, cutoffSeqInclusive: 1, messageIdsOldestFirst: [] },
                { sessionId: 'C', isReadOnlyContext: false, cutoffSeqInclusive: null, messageIdsOldestFirst: [] },
            ],
        };

        const result = insertForkDividersIntoTranscriptItems({ items: [] as ChatListItem[], fork: chain });

        expect(result.map((item) => item.kind)).toEqual([]);
    });

    it('still emits the boundary as soon as one content row exists', () => {
        const items: ChatListItem[] = [
            { kind: 'message', id: 'msg:c1', messageId: 'c1', createdAt: 1, seq: 1 },
        ];
        const withChildRow: ForkedTranscriptSnapshot = {
            ...fork,
            segments: [
                { sessionId: 'parent', isReadOnlyContext: true, cutoffSeqInclusive: 2, messageIdsOldestFirst: [] },
                { sessionId: 'child', isReadOnlyContext: false, cutoffSeqInclusive: null, messageIdsOldestFirst: ['c1'] },
            ],
            combinedMessageIdsOldestFirst: ['c1'],
            messageOriginById: { c1: { sessionId: 'child', isReadOnlyContext: false } },
            isLoaded: true,
        };

        const result = insertForkDividersIntoTranscriptItems({ items, fork: withChildRow });

        expect(result.map((item) => item.kind)).toEqual(['fork-divider', 'message']);
    });
});
