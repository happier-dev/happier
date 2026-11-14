import { describe, expect, it } from 'vitest';
import { summarizeUsageExecutionSources } from './usageSourceSummary.js';

describe('summarizeUsageExecutionSources', () => {
    it('adds reported totals and parts-only floors while retaining their provenance', () => {
        const result = summarizeUsageExecutionSources([
            { tokens: { total: 1000, input: 20 }, sourceContext: { execution: 'happier' as const } },
            { tokens: { total: null, input: 100, output: 50 }, sourceContext: { execution: 'outside' as const } },
            { tokens: { total: null }, sourceContext: { execution: 'outside' as const } },
            { tokens: { total: 0, input: 500 }, sourceContext: { execution: 'unknown' as const } },
        ]);
        expect(result).toMatchObject({ totalTokens: 1150, tokensFromParts: true, groups: [
            { execution: 'happier', tokens: 1000, share: 1000 / 1150 },
            { execution: 'outside', tokens: 150, share: 150 / 1150, tokensFromParts: true },
            { execution: 'unknown', tokens: 0, share: 0 },
        ] });
        expect(result.groups[0]).not.toHaveProperty('tokensFromParts');
    });
    it('retains unknown totals and known-only subtotals without attributing an invented zero', () => {
        const unknown = { tokens: { total: null }, sourceContext: { execution: 'outside' as const } };
        expect(summarizeUsageExecutionSources([unknown])).toMatchObject({ totalTokens: null, groups: [{ tokens: null, share: null }] });
        expect(summarizeUsageExecutionSources([unknown, { ...unknown, tokens: { total: 7 } }])).toMatchObject({ totalTokens: 7,
            coverage: 'complete', groups: [{ tokens: 7, share: 1 }] });
    });
    it('weights shares by tokens and retains unknown execution independently of native capture', () => {
        const result = summarizeUsageExecutionSources([
            { tokens: { total: 20 }, sourceContext: { path: 'native' as const, execution: 'happier' as const } },
            { tokens: { total: 30 }, sourceContext: { path: 'runtime' as const, execution: 'outside' as const } },
            { tokens: { total: 50 } },
        ]);
        expect(result).toMatchObject({ coverage: 'partial', totalTokens: 100, groups: [
            { execution: 'happier', tokens: 20, share: 0.2 },
            { execution: 'outside', tokens: 30, share: 0.3 },
            { execution: 'unknown', tokens: 50, share: 0.5 },
        ] });
        expect(summarizeUsageExecutionSources(undefined)).toEqual({ coverage: 'unknown', totalTokens: null, groups: [] });
        expect(summarizeUsageExecutionSources([])).toEqual({ coverage: 'complete', totalTokens: 0, groups: [] });
        expect(summarizeUsageExecutionSources([{ tokens: { total: 50 } }])).toMatchObject({ coverage: 'unknown',
            totalTokens: 50, groups: [{ execution: 'unknown', tokens: 50, share: 1 }] });
        expect(summarizeUsageExecutionSources([{ tokens: { total: 0 },
            sourceContext: { path: 'runtime', execution: 'happier' } }])).toMatchObject({
            totalTokens: 0, groups: [{ execution: 'happier', tokens: 0, share: null }],
        });
    });
});
