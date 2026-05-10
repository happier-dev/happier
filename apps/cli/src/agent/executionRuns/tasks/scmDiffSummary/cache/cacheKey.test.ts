import { describe, expect, it } from 'vitest';

import {
  buildScmDiffSummaryCacheKey,
  isDurableScmDiffSummaryCacheKey,
} from './cacheKey';

describe('SCM diff-summary cache keys', () => {
  it('builds durable keys from checkpoint receipt, schema version, and resolved selector', () => {
    const key = buildScmDiffSummaryCacheKey({
      source: {
        kind: 'turnCheckpoint',
        checkpointReceiptId: 'checkpoint.diff_computed',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      },
      summarySchemaVersion: 4,
      resolvedSelector: { catalogId: 'profile:fast-summary' },
    });

    expect(key).toEqual('checkpoint:refs%2Fhappier%2Fcheckpoints%2Fscope%2Fturn-final%2Fturn-1:receipt:checkpoint.diff_computed:evidence:reconciled:schema:4:selector:profile%3Afast-summary');
    expect(isDurableScmDiffSummaryCacheKey(key)).toBe(true);
  });

  it('rejects unresolved selector labels for durable checkpoint keys', () => {
    expect(() =>
      buildScmDiffSummaryCacheKey({
        source: {
          kind: 'turnCheckpoint',
          checkpointReceiptId: 'checkpoint.diff_computed',
          checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
        },
        summarySchemaVersion: 4,
        resolvedSelector: { label: 'Fast summary' },
      }),
    ).toThrow(/resolved catalog id/i);
  });

  it('ignores volatile diff digests when building durable checkpoint keys', () => {
    const base = buildScmDiffSummaryCacheKey({
      source: {
        kind: 'turnCheckpoint',
        checkpointReceiptId: 'checkpoint.diff_computed',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      },
      summarySchemaVersion: 4,
      resolvedSelector: { catalogId: 'profile:fast-summary' },
      volatileDiffDigest: 'digest-a',
    });
    const changedDigest = buildScmDiffSummaryCacheKey({
      source: {
        kind: 'turnCheckpoint',
        checkpointReceiptId: 'checkpoint.diff_computed',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      },
      summarySchemaVersion: 4,
      resolvedSelector: { catalogId: 'profile:fast-summary' },
      volatileDiffDigest: 'digest-b',
    });

    expect(changedDigest).toBe(base);
  });

  it('separates durable summaries by selected turn evidence mode', () => {
    const reconciled = buildScmDiffSummaryCacheKey({
      source: {
        kind: 'turnCheckpoint',
        checkpointReceiptId: 'checkpoint.diff_computed',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
        turnEvidenceMode: 'reconciled',
      },
      summarySchemaVersion: 4,
      resolvedSelector: { catalogId: 'profile:fast-summary' },
    });
    const checkpointOnly = buildScmDiffSummaryCacheKey({
      source: {
        kind: 'turnCheckpoint',
        checkpointReceiptId: 'checkpoint.diff_computed',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
        turnEvidenceMode: 'checkpoint',
      },
      summarySchemaVersion: 4,
      resolvedSelector: { catalogId: 'profile:fast-summary' },
    });

    expect(checkpointOnly).not.toBe(reconciled);
  });

  it('marks working tree keys as volatile and source-version scoped', () => {
    const key = buildScmDiffSummaryCacheKey({
      source: { kind: 'workingTree', volatileSourceVersion: 'status-1' },
      summarySchemaVersion: 4,
      resolvedSelector: { catalogId: 'profile:fast-summary' },
    });

    expect(key).toEqual('volatile-working-tree:status-1:schema:4:selector:profile%3Afast-summary');
    expect(isDurableScmDiffSummaryCacheKey(key)).toBe(false);
  });
});
