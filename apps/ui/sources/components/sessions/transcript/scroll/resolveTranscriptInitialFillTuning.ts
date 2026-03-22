const DEFAULT_TRANSCRIPT_INITIAL_FILL_BUDGET_MS = 1500;
const DEFAULT_TRANSCRIPT_INITIAL_FILL_MAX_NO_PROGRESS_LOADS = 2;

function normalizeBudgetMs(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return DEFAULT_TRANSCRIPT_INITIAL_FILL_BUDGET_MS;
    }
    return Math.max(1, Math.trunc(value));
}

function normalizeMaxNoProgressLoads(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return DEFAULT_TRANSCRIPT_INITIAL_FILL_MAX_NO_PROGRESS_LOADS;
    }
    return Math.trunc(value);
}

export function resolveTranscriptInitialFillTuning(params: Readonly<{
    transcriptInitialFillBudgetMs?: number;
    transcriptInitialFillMaxNoProgressLoads?: number;
}>): Readonly<{
    budgetMs: number;
    maxNoProgressLoads: number;
}> {
    return {
        budgetMs: normalizeBudgetMs(params.transcriptInitialFillBudgetMs),
        maxNoProgressLoads: normalizeMaxNoProgressLoads(params.transcriptInitialFillMaxNoProgressLoads),
    };
}
