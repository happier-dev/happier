export type AccountAuthRequestPolicy = Readonly<{
    ttlMs: number;
}>;

function clampNumber(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function resolveAccountAuthRequestPolicyFromEnv(env: NodeJS.ProcessEnv): AccountAuthRequestPolicy {
    const ttlSecondsRaw = Number(env.ACCOUNT_AUTH_REQUEST_TTL_SECONDS ?? "");
    const ttlSecondsCandidate = Number.isFinite(ttlSecondsRaw) && ttlSecondsRaw > 0 ? ttlSecondsRaw : 900;
    const ttlSeconds = clampNumber(ttlSecondsCandidate, 60, 3600);
    const ttlMs = Math.floor(ttlSeconds * 1000);
    return { ttlMs };
}

