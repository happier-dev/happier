export type TerminalAuthRequestPolicy = Readonly<{
    ttlMs: number;
    claimRetryWindowMs: number;
}>;

function clampNumber(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function resolveTerminalAuthRequestPolicyFromEnv(env: NodeJS.ProcessEnv): TerminalAuthRequestPolicy {
    const ttlSecondsRaw = Number(env.TERMINAL_AUTH_REQUEST_TTL_SECONDS ?? "");
    const ttlSecondsCandidate = Number.isFinite(ttlSecondsRaw) && ttlSecondsRaw > 0 ? ttlSecondsRaw : 900;
    const ttlSeconds = clampNumber(ttlSecondsCandidate, 60, 3600);
    const ttlMs = Math.floor(ttlSeconds * 1000);

    const retrySecondsRaw = Number(env.TERMINAL_AUTH_CLAIM_RETRY_WINDOW_SECONDS ?? "");
    const retrySecondsCandidate = Number.isFinite(retrySecondsRaw) && retrySecondsRaw >= 0 ? retrySecondsRaw : 60;
    const retrySeconds = clampNumber(retrySecondsCandidate, 0, 300);
    const claimRetryWindowMs = Math.floor(retrySeconds * 1000);

    return { ttlMs, claimRetryWindowMs };
}
