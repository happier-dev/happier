import { describe, expect, it } from 'vitest';
import {
    computeSessionMessagesPaginationUpdateFromPage,
    type SessionMessagesPaginationState,
} from './sessionMessagesPagination';

function baseState(overrides?: Partial<SessionMessagesPaginationState>): SessionMessagesPaginationState {
    return {
        beforeSeq: null,
        hasMoreOlder: null,
        paginationSupported: null,
        ...overrides,
    };
}

describe('computeSessionMessagesPaginationUpdateFromPage', () => {
    it('initializes beforeSeq from nextBeforeSeq when present', () => {
        const result = computeSessionMessagesPaginationUpdateFromPage({
            prev: baseState(),
            page: {
                messages: [{ seq: 120 }, { seq: 121 }],
                nextBeforeSeq: 119,
            },
            pageSize: 150,
            allowHasMoreInference: true,
            direction: 'older',
        });

        expect(result.next.beforeSeq).toBe(119);
    });

    it('keeps beforeSeq monotonic (never increases)', () => {
        const result = computeSessionMessagesPaginationUpdateFromPage({
            prev: baseState({ beforeSeq: 80 }),
            page: {
                messages: [{ seq: 90 }, { seq: 91 }],
            },
            pageSize: 150,
            allowHasMoreInference: true,
            direction: 'older',
        });

        expect(result.next.beforeSeq).toBe(80);
    });

    it('derives hasMoreOlder from hasMore when direction=older', () => {
        const result = computeSessionMessagesPaginationUpdateFromPage({
            prev: baseState({ hasMoreOlder: true }),
            page: {
                messages: [{ seq: 100 }],
                hasMore: false,
            },
            pageSize: 150,
            allowHasMoreInference: true,
            direction: 'older',
        });

        expect(result.next.hasMoreOlder).toBe(false);
    });

    it('resolves hasMoreOlder=false from an EMPTY older page (S-F fork parent-context gate)', () => {
        // Live native S-F RED (2026-07-11): a forked session whose child has ZERO own
        // messages fetched an empty initial page, this function early-returned leaving
        // hasMoreOlder=null (unknown), and the fork parent-context prefetch gate
        // (`hasMoreOlder === false` required on every closer segment) never opened — the
        // pre-fork parent transcript never loaded and the session rendered only the divider.
        // An empty older/initial page IS a complete answer: there are no older messages.
        const result = computeSessionMessagesPaginationUpdateFromPage({
            prev: baseState(),
            page: { messages: [] },
            pageSize: 150,
            allowHasMoreInference: true,
            direction: 'older',
        });

        expect(result.next.hasMoreOlder).toBe(false);
        expect(result.maxSeq).toBeNull();
    });

    it('honors an explicit hasMore field on an empty older page', () => {
        // A server can legitimately return an empty page while older messages exist
        // (e.g. all page candidates filtered); the explicit contract field wins over
        // the empty-page inference in both directions.
        const result = computeSessionMessagesPaginationUpdateFromPage({
            prev: baseState(),
            page: { messages: [], hasMore: true },
            pageSize: 150,
            allowHasMoreInference: true,
            direction: 'older',
        });

        expect(result.next.hasMoreOlder).toBe(true);
    });

    it('leaves state untouched for an empty page without inference or explicit field', () => {
        const result = computeSessionMessagesPaginationUpdateFromPage({
            prev: baseState({ beforeSeq: 42, hasMoreOlder: true }),
            page: { messages: [] },
            pageSize: 150,
            allowHasMoreInference: false,
            direction: 'older',
        });

        expect(result.next).toEqual({ beforeSeq: 42, hasMoreOlder: true, paginationSupported: null });
    });

    it('does not resolve hasMoreOlder from an empty newer page', () => {
        const result = computeSessionMessagesPaginationUpdateFromPage({
            prev: baseState(),
            page: { messages: [] },
            pageSize: 150,
            allowHasMoreInference: true,
            direction: 'newer',
        });

        expect(result.next.hasMoreOlder).toBeNull();
    });

    it('does not update hasMoreOlder when direction=newer', () => {
        const result = computeSessionMessagesPaginationUpdateFromPage({
            prev: baseState({ hasMoreOlder: true }),
            page: {
                messages: [{ seq: 200 }],
                hasMore: false,
            },
            pageSize: 150,
            allowHasMoreInference: true,
            direction: 'newer',
        });

        expect(result.next.hasMoreOlder).toBe(true);
    });
});

