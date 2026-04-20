function parseBoundedInt(
    rawValue: string | undefined,
    fallback: number,
    min: number,
    max: number,
): number {
    const parsed = Number.parseInt(String(rawValue ?? '').trim(), 10);
    if (!Number.isFinite(parsed) || parsed < min) {
        return fallback;
    }
    return Math.min(parsed, max);
}

export function resolveDaemonVoiceInferenceTtsLatencyBudgetMs(): number {
    return parseBoundedInt(
        process.env.EXPO_PUBLIC_HAPPIER_VOICE_DAEMON_TTS_LATENCY_BUDGET_MS,
        2_000,
        250,
        60_000,
    );
}

export function resolveDaemonVoiceInferenceTtsLatencyDemotionThreshold(): number {
    return parseBoundedInt(
        process.env.EXPO_PUBLIC_HAPPIER_VOICE_DAEMON_TTS_LATENCY_DEMOTION_THRESHOLD,
        2,
        1,
        10,
    );
}
