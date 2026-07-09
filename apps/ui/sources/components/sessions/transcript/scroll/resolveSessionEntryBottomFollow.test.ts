import { describe, expect, it } from 'vitest';

import {
    resolveSessionEntryBottomFollow,
    resolveSessionEntryViewportState,
} from './resolveSessionEntryBottomFollow';

const anchor = {
    capturedAtMs: 12,
    itemId: 'msg:a',
    itemOffsetPx: 36,
    kind: 'message' as const,
    messageId: 'a',
};

describe('session entry viewport state', () => {
    it('follows the live tail by default when no observed viewport exists', () => {
        expect(resolveSessionEntryBottomFollow(null)).toBe(true);
        expect(resolveSessionEntryViewportState(null)).toEqual({
            anchor: null,
            bottomFollowMode: 'following',
            offsetY: null,
            shouldFollowBottom: true,
        });
    });

    it('restores an observed released viewport with its finite remembered distance and anchor', () => {
        expect(resolveSessionEntryViewportState({
            anchor,
            isPinned: false,
            offsetY: 420.5,
            source: 'observed',
        })).toEqual({
            anchor,
            bottomFollowMode: 'released',
            offsetY: 420.5,
            shouldFollowBottom: false,
        });
    });

    it('keeps an invalid remembered distance as null instead of turning it into bottom', () => {
        expect(resolveSessionEntryViewportState({
            anchor,
            isPinned: false,
            offsetY: Number.POSITIVE_INFINITY,
            source: 'observed',
        })).toEqual({
            anchor,
            bottomFollowMode: 'released',
            offsetY: null,
            shouldFollowBottom: false,
        });
    });
});
