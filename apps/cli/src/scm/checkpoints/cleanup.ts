import { REPOSITORY_CHECKPOINT_RECEIPT_IDS } from './receipts';
import { parseRepositoryCheckpointRef } from './refs';
import type {
    RepositoryCheckpointCleanupRequest,
    RepositoryCheckpointCleanupResult,
    RepositoryCheckpointListedRef,
} from './types';
import { scmDiffSummaryCacheStore } from '@/agent/executionRuns/tasks/scmDiffSummary/cache/cacheStore';

const DEFAULT_MAX_FINALIZED_TURNS = 100;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function applyDiffSummaryCacheCleanup(receipts: RepositoryCheckpointCleanupResult['receipts']): void {
    for (const receipt of receipts) {
        scmDiffSummaryCacheStore.applyCheckpointCleanupReceipt(receipt);
    }
}

function isOlderThan(input: {
    ref: RepositoryCheckpointListedRef;
    nowMs: number;
    maxAgeMs: number;
}): boolean {
    if (input.ref.committedAtMs === null) return false;
    return input.nowMs - input.ref.committedAtMs > input.maxAgeMs;
}

export async function pruneRepositoryCheckpointRefs(
    input: RepositoryCheckpointCleanupRequest,
): Promise<RepositoryCheckpointCleanupResult> {
    const nowMs = input.nowMs ?? Date.now();
    const maxAgeMs = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const maxFinalizedTurns = input.maxFinalizedTurns ?? DEFAULT_MAX_FINALIZED_TURNS;
    const parsedRefs = input.refs
        .map((listedRef) => ({
            listedRef,
            parsed: parseRepositoryCheckpointRef({ scopeId: input.scopeId, ref: listedRef.ref }),
        }))
        .filter((entry): entry is {
            listedRef: RepositoryCheckpointListedRef;
            parsed: NonNullable<ReturnType<typeof parseRepositoryCheckpointRef>>;
        } => entry.parsed !== null);

    const finalizedRefs = parsedRefs
        .filter((entry) => entry.parsed.phase === 'turn-final')
        .slice()
        .sort((a, b) => (b.listedRef.committedAtMs ?? 0) - (a.listedRef.committedAtMs ?? 0));
    const prunedFinalTurnIds = new Set<string>();

    finalizedRefs.forEach((entry, index) => {
        const shouldPrune = index >= maxFinalizedTurns || isOlderThan({ ref: entry.listedRef, nowMs, maxAgeMs });
        if (shouldPrune) {
            prunedFinalTurnIds.add(entry.parsed.checkpointId);
        }
    });

    const refsToPrune = parsedRefs.filter((entry) => {
        if (entry.parsed.phase === 'turn-final') {
            return prunedFinalTurnIds.has(entry.parsed.checkpointId);
        }
        if (entry.parsed.phase === 'turn-start') {
            if (isOlderThan({ ref: entry.listedRef, nowMs, maxAgeMs })) return true;
            if (prunedFinalTurnIds.has(entry.parsed.checkpointId)) return true;
            return false;
        }
        return isOlderThan({ ref: entry.listedRef, nowMs, maxAgeMs });
    });

    const prunedRefs: string[] = [];
    for (const entry of refsToPrune) {
        try {
            await input.deleteRef(entry.listedRef.ref);
            prunedRefs.push(entry.listedRef.ref);
        } catch (error) {
            const receipts = prunedRefs.length > 0
                ? [{
                    id: REPOSITORY_CHECKPOINT_RECEIPT_IDS.cleanupPruned,
                    prunedCount: prunedRefs.length,
                    refs: prunedRefs,
                }]
                : [];
            applyDiffSummaryCacheCleanup(receipts);
            return {
                success: false,
                prunedCount: prunedRefs.length,
                prunedRefs,
                error: error instanceof Error ? error.message : 'Failed to prune repository checkpoint refs',
                receipts,
            };
        }
    }

    const receipts = prunedRefs.length > 0
        ? [{
            id: REPOSITORY_CHECKPOINT_RECEIPT_IDS.cleanupPruned,
            prunedCount: prunedRefs.length,
            refs: prunedRefs,
        }]
        : [];
    applyDiffSummaryCacheCleanup(receipts);

    return {
        success: true,
        prunedCount: prunedRefs.length,
        prunedRefs,
        receipts,
    };
}
