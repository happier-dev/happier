import { describe, expect, it } from 'vitest';

import type { Metadata } from '../types';
import {
    clampAttachCursorToDeliveredUserMessageSeq,
    mergeLocallyConsumedUserMessageSeqsV1,
    mergeDeliveredUserMessageSeqV1,
    mergeProviderAcceptedUserMessageSeqV1,
    mergeUserMessageDeliveryWatermarkModeV1,
    readDeliveredUserMessageSeqV1,
    readLocallyConsumedUserMessageSeqsV1,
    readProviderAcceptedUserMessageSeqV1,
    readUserMessageDeliveryWatermarkModeV1,
    resolveAttachCursorForUserMessageDeliveryWatermark,
} from './deliveredUserMessageSeq';

const baseMetadata: Metadata = {
    path: '/tmp/repo',
    host: 'host-1',
    homeDir: '/home/user',
    happyHomeDir: '/home/user/.happy',
    happyLibDir: '/home/user/.happy/lib',
    happyToolsDir: '/home/user/.happy/tools',
};

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

describe('readProviderAcceptedUserMessageSeqV1', () => {
    it('reads only explicit provider-accepted custody and ignores legacy delivered watermarks', () => {
        expect(readProviderAcceptedUserMessageSeqV1({ providerAcceptedUserMessageSeqV1: 7 })).toBe(7);
        expect(readProviderAcceptedUserMessageSeqV1({ providerAcceptedUserMessageSeqV1: 0 })).toBe(0);
        expect(readProviderAcceptedUserMessageSeqV1({ providerAcceptedUserMessageSeqV1: -1 })).toBeNull();
        expect(readProviderAcceptedUserMessageSeqV1({ providerAcceptedUserMessageSeqV1: 1.5 })).toBeNull();
        expect(readProviderAcceptedUserMessageSeqV1({ providerAcceptedUserMessageSeqV1: '7' })).toBeNull();
        expect(readProviderAcceptedUserMessageSeqV1({ deliveredUserMessageSeqV1: 7 })).toBeNull();
        expect(readProviderAcceptedUserMessageSeqV1({})).toBeNull();
        expect(readProviderAcceptedUserMessageSeqV1(null)).toBeNull();
        expect(readProviderAcceptedUserMessageSeqV1(undefined)).toBeNull();
    });
});

describe('mergeProviderAcceptedUserMessageSeqV1', () => {
    it('records a new provider-accepted watermark and only ever advances it', () => {
        const first = mergeProviderAcceptedUserMessageSeqV1(baseMetadata, 4);
        expect(first.changed).toBe(true);
        expect(readProviderAcceptedUserMessageSeqV1(first.metadata as unknown as Record<string, unknown>)).toBe(4);

        const regress = mergeProviderAcceptedUserMessageSeqV1(first.metadata, 2);
        expect(regress.changed).toBe(false);
        expect(readProviderAcceptedUserMessageSeqV1(regress.metadata as unknown as Record<string, unknown>)).toBe(4);

        const advance = mergeProviderAcceptedUserMessageSeqV1(first.metadata, 9);
        expect(advance.changed).toBe(true);
        expect(readProviderAcceptedUserMessageSeqV1(advance.metadata as unknown as Record<string, unknown>)).toBe(9);
    });

    it('ignores malformed seq values', () => {
        expect(mergeProviderAcceptedUserMessageSeqV1(baseMetadata, -1).changed).toBe(false);
        expect(mergeProviderAcceptedUserMessageSeqV1(baseMetadata, 1.5).changed).toBe(false);
    });
});

describe('readLocallyConsumedUserMessageSeqsV1', () => {
    it('reads exact locally consumed seqs and rejects malformed entries', () => {
        expect(readLocallyConsumedUserMessageSeqsV1({ locallyConsumedUserMessageSeqsV1: [7, 3, 7, -1, 1.5, '9'] })).toEqual([3, 7]);
        expect(readLocallyConsumedUserMessageSeqsV1({ providerAcceptedUserMessageSeqV1: 7 })).toEqual([]);
        expect(readLocallyConsumedUserMessageSeqsV1({})).toEqual([]);
        expect(readLocallyConsumedUserMessageSeqsV1(null)).toEqual([]);
        expect(readLocallyConsumedUserMessageSeqsV1(undefined)).toEqual([]);
    });
});

describe('mergeLocallyConsumedUserMessageSeqsV1', () => {
    it('records exact locally consumed seqs without advancing provider custody', () => {
        const first = mergeLocallyConsumedUserMessageSeqsV1(baseMetadata, [4, 2]);
        expect(first.changed).toBe(true);
        expect(readLocallyConsumedUserMessageSeqsV1(first.metadata as unknown as Record<string, unknown>)).toEqual([2, 4]);
        expect(readProviderAcceptedUserMessageSeqV1(first.metadata as unknown as Record<string, unknown>)).toBeNull();

        const unchanged = mergeLocallyConsumedUserMessageSeqsV1(first.metadata, [4, 2]);
        expect(unchanged.changed).toBe(false);
        expect(unchanged.metadata).toBe(first.metadata);

        const advance = mergeLocallyConsumedUserMessageSeqsV1(first.metadata, [9]);
        expect(advance.changed).toBe(true);
        expect(readLocallyConsumedUserMessageSeqsV1(advance.metadata as unknown as Record<string, unknown>)).toEqual([2, 4, 9]);
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

describe('readUserMessageDeliveryWatermarkModeV1', () => {
    it('reads only supported watermark modes', () => {
        expect(readUserMessageDeliveryWatermarkModeV1({ userMessageDeliveryWatermarkModeV1: 'queueHandoff' })).toBe('queueHandoff');
        expect(readUserMessageDeliveryWatermarkModeV1({ userMessageDeliveryWatermarkModeV1: 'providerAcceptance' })).toBe('providerAcceptance');
        expect(readUserMessageDeliveryWatermarkModeV1({ userMessageDeliveryWatermarkModeV1: 'provider' })).toBeNull();
        expect(readUserMessageDeliveryWatermarkModeV1({ userMessageDeliveryWatermarkModeV1: null })).toBeNull();
        expect(readUserMessageDeliveryWatermarkModeV1(null)).toBeNull();
    });
});

describe('mergeUserMessageDeliveryWatermarkModeV1', () => {
    it('records a supported watermark mode without rewriting an unchanged value', () => {
        const first = mergeUserMessageDeliveryWatermarkModeV1(baseMetadata, 'providerAcceptance');
        expect(first.changed).toBe(true);
        expect(readUserMessageDeliveryWatermarkModeV1(first.metadata as unknown as Record<string, unknown>)).toBe('providerAcceptance');

        const unchanged = mergeUserMessageDeliveryWatermarkModeV1(first.metadata, 'providerAcceptance');
        expect(unchanged.changed).toBe(false);
        expect(unchanged.metadata).toBe(first.metadata);
    });
});

describe('resolveAttachCursorForUserMessageDeliveryWatermark', () => {
    it('uses queue-delivery metadata for queue-handoff sessions', () => {
        expect(resolveAttachCursorForUserMessageDeliveryWatermark({
            cursor: 42,
            mode: 'queueHandoff',
            deliveredUserMessageSeq: 5,
            providerAcceptedUserMessageSeq: 3,
        })).toEqual({ cursor: 5, effectiveWatermarkSeq: 5 });
    });

    it('uses only provider-accepted custody for provider-acceptance sessions', () => {
        expect(resolveAttachCursorForUserMessageDeliveryWatermark({
            cursor: 42,
            mode: 'providerAcceptance',
            deliveredUserMessageSeq: 5,
            providerAcceptedUserMessageSeq: 3,
        })).toEqual({ cursor: 3, effectiveWatermarkSeq: 3 });
    });

    it('replays from the beginning when provider-acceptance sessions lack explicit custody', () => {
        expect(resolveAttachCursorForUserMessageDeliveryWatermark({
            cursor: 42,
            mode: 'providerAcceptance',
            deliveredUserMessageSeq: 5,
            providerAcceptedUserMessageSeq: null,
        })).toEqual({ cursor: 0, effectiveWatermarkSeq: 0 });
    });
});
