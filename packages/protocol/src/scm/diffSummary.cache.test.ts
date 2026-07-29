import { describe, expect, it } from 'vitest';

import {
  ScmDiffSummaryCacheEntrySchema,
  ScmDiffSummaryCacheKeyDescriptorSchema,
  ScmDiffSummaryGenerateInputSchema,
  ScmDiffSummaryGenerateOutputSchema,
} from './diffSummary.js';

describe('SCM diff-summary cache protocol', () => {
  it('requires receipt, schema version, and resolved selector for durable checkpoint cache descriptors', () => {
    expect(ScmDiffSummaryCacheKeyDescriptorSchema.parse({
      source: { kind: 'turnCheckpoint' },
      checkpointReceiptId: 'checkpoint.diff_computed',
      checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      summarySchemaVersion: 4,
      resolvedSelector: { catalogId: 'profile:fast-summary' },
    })).toMatchObject({
      checkpointReceiptId: 'checkpoint.diff_computed',
      checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      resolvedSelector: { catalogId: 'profile:fast-summary' },
    });

    expect(ScmDiffSummaryCacheKeyDescriptorSchema.safeParse({
      source: { kind: 'turnCheckpoint' },
      checkpointReceiptId: 'checkpoint.diff_computed',
      checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      summarySchemaVersion: 4,
      resolvedSelector: { label: 'Fast summary' },
    }).success).toBe(false);
  });

  it('marks working-tree cache descriptors as volatile instead of durable', () => {
    expect(ScmDiffSummaryCacheKeyDescriptorSchema.parse({
      source: { kind: 'workingTree' },
      volatileSourceVersion: 'status-1',
      summarySchemaVersion: 4,
      resolvedSelector: { catalogId: 'profile:fast-summary' },
    })).toMatchObject({
      source: { kind: 'workingTree' },
      volatileSourceVersion: 'status-1',
    });
  });

  it('types cost and partial-state metadata for UI cache projection', () => {
    const output = ScmDiffSummaryGenerateOutputSchema.parse({
      success: true,
      summaryMarkdown: '## Summary\n\nUpdated cache projection.',
      sourceKey: 'turn:turn-1',
      checkpointReceiptId: 'checkpoint.diff_computed',
      metadata: {
        source: { kind: 'turnCheckpoint' },
        sourceKey: 'turn:turn-1',
        checkpointReceiptId: 'checkpoint.diff_computed',
      },
      generationState: 'partial',
      cost: { estimatedUsd: 0.03 },
      truncation: { reason: 'diffBytes', droppedFiles: 3 },
    });

    expect(ScmDiffSummaryCacheEntrySchema.parse({
      key: {
        source: { kind: 'turnCheckpoint' },
        checkpointReceiptId: 'checkpoint.diff_computed',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
        summarySchemaVersion: 4,
        resolvedSelector: { catalogId: 'profile:fast-summary' },
      },
      checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      value: output,
    })).toMatchObject({
      value: {
        generationState: 'partial',
        cost: { estimatedUsd: 0.03 },
      },
    });
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
        reason: 'explicit_regenerate',
      },
    })).toMatchObject({
      cachePolicy: {
        mode: 'bypass',
        reason: 'explicit_regenerate',
      },
    });
  });
});
