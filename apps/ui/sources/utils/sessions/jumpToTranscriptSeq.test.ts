import { describe, expect, it, vi } from 'vitest';

import { jumpToTranscriptSeq } from './jumpToTranscriptSeq';

describe('jumpToTranscriptSeq', () => {
    it('scrolls immediately when the target is already in view', async () => {
        const scrollToIndex = vi.fn();
        const loadOlder = vi.fn(async () => ({ status: 'loaded', hasMore: false } as const));
        let index = 7;

        const result = await jumpToTranscriptSeq({
            targetSeq: 42,
            getIndex: () => index,
            loadOlder,
            scrollToIndex,
            maxLoads: 5,
        });

        expect(result.status).toBe('scrolled');
        expect(scrollToIndex).toHaveBeenCalledWith(7);
        expect(loadOlder).not.toHaveBeenCalled();
    });

    it('loads older pages until the target is in view', async () => {
        const scrollToIndex = vi.fn();
        const loadOlder = vi.fn(async () => ({ status: 'loaded', hasMore: true } as const));
        let attempts = 0;

        const result = await jumpToTranscriptSeq({
            targetSeq: 100,
            getIndex: () => (attempts >= 1 ? 3 : null),
            loadOlder: async () => {
                attempts += 1;
                return await loadOlder();
            },
            scrollToIndex,
            maxLoads: 5,
        });

        expect(result.status).toBe('scrolled');
        expect(loadOlder).toHaveBeenCalledTimes(1);
        expect(scrollToIndex).toHaveBeenCalledWith(3);
    });
});

