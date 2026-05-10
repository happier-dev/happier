import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createScmDiffSummaryCacheStore } from './cacheStore';

describe('SCM diff-summary cache store', () => {
  it('reuses checkpoint summaries by durable checkpoint-ref key', () => {
    const store = createScmDiffSummaryCacheStore();
    const keyInput = {
      source: {
        kind: 'turnCheckpoint' as const,
        checkpointReceiptId: 'checkpoint.diff_computed',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      },
      summarySchemaVersion: 4,
      resolvedSelector: { catalogId: 'profile:fast-summary' },
    };

    store.set({
      keyInput,
      checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      value: {
        summaryMarkdown: 'Changed cache behavior.',
        state: 'complete',
        cost: { estimatedUsd: 0.01 },
      },
    });

    expect(store.get(keyInput)).toMatchObject({
      summaryMarkdown: 'Changed cache behavior.',
      state: 'complete',
      cost: { estimatedUsd: 0.01 },
    });
  });

  it('does not persist working tree summaries across source-version changes', () => {
    const store = createScmDiffSummaryCacheStore();
    store.set({
      keyInput: {
        source: { kind: 'workingTree' as const, volatileSourceVersion: 'status-1' },
        summarySchemaVersion: 4,
        resolvedSelector: { catalogId: 'profile:fast-summary' },
      },
      value: { summaryMarkdown: 'Current worktree.', state: 'complete' },
    });

    expect(store.get({
      source: { kind: 'workingTree', volatileSourceVersion: 'status-2' },
      summarySchemaVersion: 4,
      resolvedSelector: { catalogId: 'profile:fast-summary' },
    })).toBeNull();
  });

  it('prunes checkpoint summaries after cleanup receipts reference their checkpoint refs', () => {
    const store = createScmDiffSummaryCacheStore();
    const keyInput = {
      source: {
        kind: 'turnCheckpoint' as const,
        checkpointReceiptId: 'checkpoint.diff_computed',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/pruned-turn',
      },
      summarySchemaVersion: 4,
      resolvedSelector: { catalogId: 'profile:fast-summary' },
    };
    store.set({
      keyInput,
      checkpointRef: 'refs/happier/checkpoints/scope/turn-final/pruned-turn',
      value: { summaryMarkdown: 'Old checkpoint.', state: 'complete' },
    });

    const result = store.applyCheckpointCleanupReceipt({
      id: 'checkpoint.cleanup_pruned',
      refs: ['refs/happier/checkpoints/scope/turn-final/pruned-turn'],
      prunedCount: 1,
    });

    expect(result).toEqual({ prunedEntries: 1 });
    expect(store.get(keyInput)).toBeNull();
  });

  it('reopens checkpoint summaries from durable local cache storage without raw source diffs', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-scm-diff-summary-cache-'));
    try {
      const filePath = join(root, 'summary-cache.json');
      const keyInput = {
        source: {
          kind: 'turnCheckpoint' as const,
          checkpointReceiptId: 'checkpoint.diff_computed',
          checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
        },
        summarySchemaVersion: 4,
        resolvedSelector: { catalogId: 'profile:fast-summary' },
      };

      createScmDiffSummaryCacheStore({ filePath }).set({
        keyInput,
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
        value: {
          success: true,
          summaryMarkdown: '## Summary\n\nDurable checkpoint summary.',
          sourceKey: 'turnCheckpoint:turn-1:checkpoint.diff_computed',
          checkpointReceiptId: 'checkpoint.diff_computed',
          metadata: {
            source: { kind: 'turnCheckpoint' },
            sourceKey: 'turnCheckpoint:turn-1:checkpoint.diff_computed',
            checkpointReceiptId: 'checkpoint.diff_computed',
          },
        },
      });

      const reopened = createScmDiffSummaryCacheStore({ filePath });

      expect(reopened.get(keyInput)).toMatchObject({
        success: true,
        summaryMarkdown: '## Summary\n\nDurable checkpoint summary.',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
