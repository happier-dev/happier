import { describe, expect, it } from 'vitest';

import type { Metadata } from '../types';
import {
    clampAttachCursorToDeliveredUserMessageSeq,
    mergeDeliveredUserMessageSeqV1,
    readDeliveredUserMessageSeqV1,
} from './deliveredUserMessageSeq';

const baseMetadata: Metadata = { path: '/tmp/repo', host: 'host-1' };

describe('readDeliveredUserMessageSeqV1', () => {
    it('reads a valid watermark and rejects malformed values', () => {
        expect(readDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: 7 })).toBe(7);
        expect(readDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: 0 })).toBe(0);
        expect(readDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: -1 })).toBeNull();
        expect(readDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: 1.5 })).toBeNull();
        expect(readDeliveredUserMessageSeqV1({ deliveredUserMessageSeqV1: '7' })).toBeNull();
        expect(readDeliveredUserMessageSeqV1({})).toBeNull();
        expect(readDeliveredUserMessageSeqV1(null)).toBeNull();
        expect(readDeliveredUserMessageSeqV1(undefined)).toBeNull();
    });
});

describe('mergeDeliveredUserMessageSeqV1', () => {
    it('records a new watermark and only ever advances it', () => {
        const first = mergeDeliveredUserMessageSeqV1(baseMetadata, 4);
        expect(first.changed).toBe(true);
        expect(readDeliveredUserMessageSeqV1(first.metadata as unknown as Record<string, unknown>)).toBe(4);

        const regress = mergeDeliveredUserMessageSeqV1(first.metadata, 2);
        expect(regress.changed).toBe(false);
        expect(readDeliveredUserMessageSeqV1(regress.metadata as unknown as Record<string, unknown>)).toBe(4);

        const advance = mergeDeliveredUserMessageSeqV1(first.metadata, 9);
        expect(advance.changed).toBe(true);
        expect(readDeliveredUserMessageSeqV1(advance.metadata as unknown as Record<string, unknown>)).toBe(9);
    });

    it('ignores malformed seq values', () => {
        expect(mergeDeliveredUserMessageSeqV1(baseMetadata, -1).changed).toBe(false);
        expect(mergeDeliveredUserMessageSeqV1(baseMetadata, 1.5).changed).toBe(false);
    });
});

describe('clampAttachCursorToDeliveredUserMessageSeq', () => {
    it('clamps the cursor down to the delivered watermark', () => {
        expect(clampAttachCursorToDeliveredUserMessageSeq(42, 5)).toBe(5);
        expect(clampAttachCursorToDeliveredUserMessageSeq(3, 5)).toBe(3);
    });

    it('keeps legacy behavior when no watermark exists', () => {
        expect(clampAttachCursorToDeliveredUserMessageSeq(42, null)).toBe(42);
        expect(clampAttachCursorToDeliveredUserMessageSeq(undefined, 5)).toBeUndefined();
    });
});
