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

