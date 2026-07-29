const DEFAULT_TURN_DIFF_FILE_BUDGET_BYTES = 256 * 1024;
const DEFAULT_TURN_DIFF_TURN_BUDGET_BYTES = 1024 * 1024;

function resolveNonNegativeInt(input: unknown, fallback: number): number {
    if (typeof input === 'number' && Number.isFinite(input) && input >= 0) return Math.trunc(input);
    const raw = String(input ?? '').trim();
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.trunc(parsed);
}

export function resolveTurnDiffFileBudgetBytes(input?: unknown): number {
    return resolveNonNegativeInt(
        input ?? process.env.HAPPIER_TURN_DIFF_FILE_BUDGET_BYTES,
        DEFAULT_TURN_DIFF_FILE_BUDGET_BYTES,
    );
}

export function resolveTurnDiffTurnBudgetBytes(input?: unknown): number {
    return resolveNonNegativeInt(
        input ?? process.env.HAPPIER_TURN_DIFF_TURN_BUDGET_BYTES,
        DEFAULT_TURN_DIFF_TURN_BUDGET_BYTES,
    );
}
