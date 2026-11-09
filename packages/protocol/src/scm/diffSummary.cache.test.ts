import { describe, expect, it } from 'vitest';

import {
  ScmDiffSummaryGenerateInputSchema,
  ScmDiffSummaryGenerateOutputSchema,
  buildScmDiffSummaryCacheKey,
} from './diffSummary.js';

describe('SCM diff-summary cache protocol', () => {
  it('separates investigated generation from evidence-only generation without changing the captured comparison identity', () => {
    const base = { source: { kind: 'comparison' as const, comparisonId: 'exact-tree-pair' },
      summarySchemaVersion: 1, resolvedSelector: { catalogId: 'model:one' } };
    expect(buildScmDiffSummaryCacheKey({ ...base, investigateSurroundingFiles: true })).not.toBe(buildScmDiffSummaryCacheKey(base));
    expect(buildScmDiffSummaryCacheKey({ ...base, investigateSurroundingFiles: false })).toBe(buildScmDiffSummaryCacheKey(base));
  });
  it('separates prose languages while preserving omitted-language cache keys', () => {
    const base = { source: { kind: 'comparison' as const, comparisonId: 'exact-tree-pair' },
      summarySchemaVersion: 1, resolvedSelector: { catalogId: 'model:one' } };
    expect(buildScmDiffSummaryCacheKey({ ...base, outputLanguage: 'fr' })).not.toBe(buildScmDiffSummaryCacheKey(base));
    expect(buildScmDiffSummaryCacheKey({ ...base, outputLanguage: 'fr' })).not.toBe(buildScmDiffSummaryCacheKey({ ...base, outputLanguage: 'de' }));
  });
  it('does not reuse summary-only analysis for requested walkthrough output', () => {
    const base = { source: { kind: 'comparison' as const, comparisonId: 'exact-tree-pair' },
      summarySchemaVersion: 1, resolvedSelector: { catalogId: 'model:one' } };
    expect(buildScmDiffSummaryCacheKey(base)).not.toBe(buildScmDiffSummaryCacheKey({ ...base, outputs: ['walkthrough'] }));
    expect(buildScmDiffSummaryCacheKey({ ...base, outputs: ['summary', 'walkthrough'] }))
      .toBe(buildScmDiffSummaryCacheKey({ ...base, outputs: ['walkthrough', 'summary'] }));
  });

  it('preserves forward-compatible public cost metadata fields', () => {
    expect(ScmDiffSummaryGenerateOutputSchema.parse({
      success: true,
      summaryMarkdown: '## Summary\n\nUpdated cache projection.',
      sourceKey: 'turn:turn-1',
      metadata: {
        source: { kind: 'turnCheckpoint' },
        sourceKey: 'turn:turn-1',
      },
      cost: {
        estimatedUsd: 0.03,
        vendorTraceId: 'trace-1',
      },
    })).toMatchObject({
      cost: {
        estimatedUsd: 0.03,
        vendorTraceId: 'trace-1',
      },
    });
  });

  it('preserves future-only public cost metadata objects', () => {
    expect(ScmDiffSummaryGenerateOutputSchema.parse({
      success: true,
      summaryMarkdown: '## Summary\n\nUpdated cache projection.',
      sourceKey: 'turn:turn-1',
      metadata: {
        source: { kind: 'turnCheckpoint' },
        sourceKey: 'turn:turn-1',
      },
      cost: {
        providerMetering: {
          inputCacheReadTokens: 12,
        },
      },
    })).toMatchObject({
      cost: {
        providerMetering: {
          inputCacheReadTokens: 12,
        },
      },
    });
  });

  it('carries explicit cache bypass policy through generate input', () => {
    expect(ScmDiffSummaryGenerateInputSchema.parse({
      cwd: '/repo',
      source: { kind: 'turnCheckpoint' },
      checkpointReceiptId: 'checkpoint.diff_computed',
      cachePolicy: {
        mode: 'bypass',
      },
    })).toMatchObject({
      cachePolicy: {
        mode: 'bypass',
      },
    });
  });
});
