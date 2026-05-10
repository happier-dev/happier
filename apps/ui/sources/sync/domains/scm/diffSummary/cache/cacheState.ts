import {
    buildScmDiffSummaryCacheKey,
    type ScmDiffSummaryCacheKeyInput,
} from './cacheKey';
import type { ScmDiffSummaryGenerateOutput } from '@happier-dev/protocol';

type ScmDiffSummaryProjectedUiCacheEntry = Readonly<{
    summaryMarkdown: string;
    state: 'complete' | 'partial';
    truncation?: Readonly<{
        reason: string;
        droppedFiles?: number;
    }>;
    cost?: Readonly<{
        inputTokens?: number;
        outputTokens?: number;
        estimatedUsd?: number;
    }>;
}>;

export type ScmDiffSummaryUiCacheEntry = ScmDiffSummaryGenerateOutput | ScmDiffSummaryProjectedUiCacheEntry;

export type ScmDiffSummaryCacheState = Readonly<{
    entriesByKey: Readonly<Record<string, ScmDiffSummaryUiCacheEntry>>;
    checkpointRefByKey: Readonly<Record<string, string>>;
}>;

export type ScmDiffSummaryCachePutInput = Readonly<{
    keyInput: ScmDiffSummaryCacheKeyInput;
    checkpointRef?: string;
    entry: ScmDiffSummaryUiCacheEntry;
    volatileDiffDigest?: string;
}>;

export type CheckpointCleanupReceiptLike = Readonly<{
    id: string;
    refs?: readonly string[];
    prunedCount?: number;
}>;

export function createScmDiffSummaryCacheState(): ScmDiffSummaryCacheState {
    return {
        entriesByKey: {},
        checkpointRefByKey: {},
    };
}

export function putScmDiffSummaryCacheEntry(
    state: ScmDiffSummaryCacheState,
    input: ScmDiffSummaryCachePutInput,
): ScmDiffSummaryCacheState {
    const key = buildScmDiffSummaryCacheKey(input.keyInput);
    const checkpointRef = input.checkpointRef?.trim();
    const nextCheckpointRefByKey = { ...state.checkpointRefByKey };
    if (checkpointRef) {
        nextCheckpointRefByKey[key] = checkpointRef;
    } else {
        delete nextCheckpointRefByKey[key];
    }

    return {
        entriesByKey: {
            ...state.entriesByKey,
            [key]: input.entry,
        },
        checkpointRefByKey: nextCheckpointRefByKey,
    };
}

export function getScmDiffSummaryCacheEntry(
    state: ScmDiffSummaryCacheState,
    input: ScmDiffSummaryCacheKeyInput,
): ScmDiffSummaryUiCacheEntry | null {
    const key = buildScmDiffSummaryCacheKey(input);
    return state.entriesByKey[key] ?? null;
}

export function pruneScmDiffSummaryCacheByCheckpointCleanupReceipt(
    state: ScmDiffSummaryCacheState,
    receipt: CheckpointCleanupReceiptLike,
): Readonly<{
    state: ScmDiffSummaryCacheState;
    prunedEntries: number;
}> {
    if (receipt.id !== 'checkpoint.cleanup_pruned' || !receipt.refs || receipt.refs.length === 0) {
        return { state, prunedEntries: 0 };
    }

    const refs = new Set(receipt.refs);
    const entriesByKey: Record<string, ScmDiffSummaryUiCacheEntry> = {};
    const checkpointRefByKey: Record<string, string> = {};
    let prunedEntries = 0;

    for (const [key, entry] of Object.entries(state.entriesByKey)) {
        const checkpointRef = state.checkpointRefByKey[key];
        if (checkpointRef && refs.has(checkpointRef)) {
            prunedEntries += 1;
            continue;
        }
        entriesByKey[key] = entry;
        if (checkpointRef) {
            checkpointRefByKey[key] = checkpointRef;
        }
    }

    if (prunedEntries === 0) {
        return { state, prunedEntries: 0 };
    }

    return {
        state: { entriesByKey, checkpointRefByKey },
        prunedEntries,
    };
}
