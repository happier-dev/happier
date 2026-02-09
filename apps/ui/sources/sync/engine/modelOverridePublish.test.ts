import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/storageTypes';

import { computeNextModelOverrideMetadata, publishModelOverrideToMetadata } from './modelOverridePublish';

function buildMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    };
}

describe('computeNextModelOverrideMetadata', () => {
    it('updates modelOverrideV1 when updatedAt is newer', () => {
        const base = buildMetadata();
        const next = computeNextModelOverrideMetadata({
            metadata: base,
            modelId: 'gemini-2.5-pro',
            updatedAt: 11,
        });

        expect(next.modelOverrideV1).toEqual({ v: 1, updatedAt: 11, modelId: 'gemini-2.5-pro' });
    });

    it('applies a monotonic bump when model changes with an older updatedAt', () => {
        const base = buildMetadata({
            modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gemini-2.5-flash' },
        });

        const next = computeNextModelOverrideMetadata({
            metadata: base,
            modelId: 'gemini-2.5-pro',
            updatedAt: 9,
        });

        expect(next.modelOverrideV1?.modelId).toBe('gemini-2.5-pro');
        expect(next.modelOverrideV1?.updatedAt).toBe(11);
    });

    it('returns metadata unchanged when model and updatedAt are unchanged', () => {
        const base = buildMetadata({
            modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gemini-2.5-pro' },
        });

        const next = computeNextModelOverrideMetadata({
            metadata: base,
            modelId: 'gemini-2.5-pro',
            updatedAt: 10,
        });

        expect(next).toBe(base);
    });

    it('updates timestamp when updatedAt is newer even for the same model id', () => {
        const base = buildMetadata({
            modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gemini-2.5-pro' },
        });

        const next = computeNextModelOverrideMetadata({
            metadata: base,
            modelId: 'gemini-2.5-pro',
            updatedAt: 12,
        });

        expect(next.modelOverrideV1).toEqual({ v: 1, updatedAt: 12, modelId: 'gemini-2.5-pro' });
    });

    it('applies a deterministic sequence across newer + stale updates', () => {
        const base = buildMetadata();
        const first = computeNextModelOverrideMetadata({
            metadata: base,
            modelId: 'gemini-2.5-flash',
            updatedAt: 10,
        });
        const second = computeNextModelOverrideMetadata({
            metadata: first,
            modelId: 'gemini-2.5-pro',
            updatedAt: 9,
        });
        const third = computeNextModelOverrideMetadata({
            metadata: second,
            modelId: 'gemini-2.5-pro',
            updatedAt: 15,
        });

        expect(first.modelOverrideV1).toEqual({ v: 1, updatedAt: 10, modelId: 'gemini-2.5-flash' });
        expect(second.modelOverrideV1).toEqual({ v: 1, updatedAt: 11, modelId: 'gemini-2.5-pro' });
        expect(third.modelOverrideV1).toEqual({ v: 1, updatedAt: 15, modelId: 'gemini-2.5-pro' });
    });
});

describe('publishModelOverrideToMetadata', () => {
    it('publishes model override via updateSessionMetadataWithRetry updater', async () => {
        const updates: Metadata[] = [];
        const base = buildMetadata();

        await publishModelOverrideToMetadata({
            sessionId: 's1',
            modelId: 'gemini-2.5-pro',
            updatedAt: 12,
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(base));
            },
        });

        expect(updates).toHaveLength(1);
        expect(updates[0]?.modelOverrideV1).toEqual({
            v: 1,
            updatedAt: 12,
            modelId: 'gemini-2.5-pro',
        });
    });
});
