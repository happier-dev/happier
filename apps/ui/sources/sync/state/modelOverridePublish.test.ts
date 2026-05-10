import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import { publishModelOverrideToMetadata } from './modelOverridePublish';

function buildMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    };
}

describe('publishModelOverrideToMetadata', () => {
    it('publishes model override through the UI session-state engine', async () => {
        const updates: Metadata[] = [];

        await publishModelOverrideToMetadata({
            sessionId: 's1',
            modelId: 'gemini-2.5-pro',
            updatedAt: 12,
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(buildMetadata()));
            },
        });

        expect(updates).toEqual([
            expect.objectContaining({
                modelOverrideV1: { v: 1, updatedAt: 12, modelId: 'gemini-2.5-pro' },
            }),
        ]);
    });

    it('keeps the shared model override conflict policy behind the engine', async () => {
        const updates: Metadata[] = [];

        await publishModelOverrideToMetadata({
            sessionId: 's1',
            modelId: 'gemini-2.5-pro',
            updatedAt: 9,
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(buildMetadata({
                    modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gemini-2.5-flash' },
                })));
            },
        });

        expect(updates).toEqual([
            expect.objectContaining({
                modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'gemini-2.5-pro' },
            }),
        ]);
    });
});
