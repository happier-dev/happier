export type PairingAuthPolicy = Readonly<{
    ttlMs: number;
}>;

function clampNumber(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function resolvePairingAuthPolicyFromEnv(env: NodeJS.ProcessEnv): PairingAuthPolicy {
    const ttlSecondsRaw = Number(env.AUTH_PAIRING_TTL_SECONDS ?? "");
    const ttlSecondsCandidate = Number.isFinite(ttlSecondsRaw) && ttlSecondsRaw > 0 ? ttlSecondsRaw : 120;
    const ttlSeconds = clampNumber(ttlSecondsCandidate, 30, 600);
    return { ttlMs: Math.floor(ttlSeconds * 1000) };
}
