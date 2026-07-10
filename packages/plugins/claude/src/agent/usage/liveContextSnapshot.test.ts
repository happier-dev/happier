import { describe, expect, it } from 'vitest';

import * as usage from './index.js';

describe('buildClaudeLiveContextUsageSnapshot', () => {
    it('maps provider live totals, window, categories, and compaction state', () => {
        expect(usage.buildClaudeLiveContextUsageSnapshot({
            response: {
                totalTokens: 48_000,
                maxTokens: 200_000,
                model: 'claude-sonnet-4-6',
                isAutoCompactEnabled: true,
                categories: [
                    { name: 'System prompt', tokens: 8_000, color: 'gray' },
                    { name: 'Messages', tokens: 40_000, color: 'blue' },
                ],
            },
            observedAtMs: 1_752_089_600_000,
        })).toEqual({
            v: 1,
            modelId: 'claude-sonnet-4-6',
            usedTokens: 48_000,
            windowTokens: 200_000,
            totalProcessedTokens: null,
            baselineTokens: null,
            isAutoCompactEnabled: true,
            categories: [
                { key: 'System prompt', label: null, tokens: 8_000 },
                { key: 'Messages', label: null, tokens: 40_000 },
            ],
            observedAtMs: 1_752_089_600_000,
            source: 'provider_live',
        });
    });

    it('rejects responses without a provider total and tolerates optional detail gaps', () => {
        expect(usage.buildClaudeLiveContextUsageSnapshot({
            response: { maxTokens: 200_000 },
            observedAtMs: 1,
        })).toBeNull();
        expect(usage.buildClaudeLiveContextUsageSnapshot({
            response: { totalTokens: 10 },
            observedAtMs: 1,
        })).toEqual(expect.objectContaining({
            modelId: null,
            windowTokens: null,
            categories: null,
            isAutoCompactEnabled: null,
        }));
    });
});
