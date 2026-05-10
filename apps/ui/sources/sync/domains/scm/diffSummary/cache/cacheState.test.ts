import { describe, expect, it } from 'vitest';

import {
    createScmDiffSummaryCacheState,
    getScmDiffSummaryCacheEntry,
    pruneScmDiffSummaryCacheByCheckpointCleanupReceipt,
    putScmDiffSummaryCacheEntry,
} from './cacheState';

describe('UI SCM diff-summary cache state', () => {
    it('stores UI metadata without raw diff payload material', () => {
        const state = putScmDiffSummaryCacheEntry(createScmDiffSummaryCacheState(), {
            keyInput: {
                source: {
                    kind: 'turnCheckpoint',
                    checkpointReceiptId: 'checkpoint.diff_computed',
                    checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
                },
                summarySchemaVersion: 4,
                resolvedSelector: { catalogId: 'profile:fast-summary' },
            },
            checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
            entry: {
                summaryMarkdown: 'Updated cache state.',
                state: 'partial',
                truncation: { reason: 'fileBudget', droppedFiles: 2 },
                cost: { estimatedUsd: 0.02 },
            },
            volatileDiffDigest: 'digest-that-must-not-key-durable-state',
        });

        const serialized = JSON.stringify(state);
        expect(serialized).not.toContain('digest-that-must-not-key-durable-state');
        expect(getScmDiffSummaryCacheEntry(state, {
            source: {
                kind: 'turnCheckpoint',
                checkpointReceiptId: 'checkpoint.diff_computed',
                checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
            },
            summarySchemaVersion: 4,
            resolvedSelector: { catalogId: 'profile:fast-summary' },
        })).toMatchObject({
            state: 'partial',
            truncation: { reason: 'fileBudget', droppedFiles: 2 },
            cost: { estimatedUsd: 0.02 },
        });
    });

    it('keeps working-tree entries volatile to source-version changes', () => {
        const state = putScmDiffSummaryCacheEntry(createScmDiffSummaryCacheState(), {
            keyInput: {
                source: { kind: 'workingTree', volatileSourceVersion: 'status-1' },
                summarySchemaVersion: 4,
                resolvedSelector: { catalogId: 'profile:fast-summary' },
            },
            entry: { summaryMarkdown: 'Current working tree.', state: 'complete' },
        });

        expect(getScmDiffSummaryCacheEntry(state, {
            source: { kind: 'workingTree', volatileSourceVersion: 'status-2' },
            summarySchemaVersion: 4,
            resolvedSelector: { catalogId: 'profile:fast-summary' },
        })).toBeNull();
    });

    it('removes checkpoint cache entries after checkpoint cleanup receipts', () => {
        const state = putScmDiffSummaryCacheEntry(createScmDiffSummaryCacheState(), {
            keyInput: {
                source: {
                    kind: 'turnCheckpoint',
                    checkpointReceiptId: 'checkpoint.diff_computed',
                    checkpointRef: 'refs/happier/checkpoints/scope/turn-final/pruned-turn',
                },
                summarySchemaVersion: 4,
                resolvedSelector: { catalogId: 'profile:fast-summary' },
            },
            checkpointRef: 'refs/happier/checkpoints/scope/turn-final/pruned-turn',
            entry: { summaryMarkdown: 'Pruned checkpoint.', state: 'complete' },
        });

        const pruned = pruneScmDiffSummaryCacheByCheckpointCleanupReceipt(state, {
            id: 'checkpoint.cleanup_pruned',
            refs: ['refs/happier/checkpoints/scope/turn-final/pruned-turn'],
            prunedCount: 1,
        });

        expect(pruned.prunedEntries).toBe(1);
        expect(getScmDiffSummaryCacheEntry(pruned.state, {
            source: {
                kind: 'turnCheckpoint',
                checkpointReceiptId: 'checkpoint.diff_computed',
                checkpointRef: 'refs/happier/checkpoints/scope/turn-final/pruned-turn',
            },
            summarySchemaVersion: 4,
            resolvedSelector: { catalogId: 'profile:fast-summary' },
        })).toBeNull();
    });

    it('replaces stale checkpoint ref indexes when an entry is rewritten without a ref', () => {
        const keyInput = {
            source: {
                kind: 'turnCheckpoint' as const,
                checkpointReceiptId: 'checkpoint.diff_computed',
                checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
            },
            summarySchemaVersion: 4,
            resolvedSelector: { catalogId: 'profile:fast-summary' },
        };
        const withRef = putScmDiffSummaryCacheEntry(createScmDiffSummaryCacheState(), {
            keyInput,
            checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
            entry: { summaryMarkdown: 'Initial checkpoint.', state: 'complete' },
        });

        const rewritten = putScmDiffSummaryCacheEntry(withRef, {
            keyInput,
            entry: { summaryMarkdown: 'Rewritten checkpoint.', state: 'complete' },
        });
        const pruned = pruneScmDiffSummaryCacheByCheckpointCleanupReceipt(rewritten, {
            id: 'checkpoint.cleanup_pruned',
            refs: ['refs/happier/checkpoints/scope/turn-final/turn-1'],
            prunedCount: 1,
        });

        expect(pruned.prunedEntries).toBe(0);
        expect(getScmDiffSummaryCacheEntry(pruned.state, keyInput)?.summaryMarkdown).toBe('Rewritten checkpoint.');
    });
});
