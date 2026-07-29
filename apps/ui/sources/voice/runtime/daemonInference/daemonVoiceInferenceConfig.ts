import {
    VOICE_RUNTIME_TTS_DEFAULTS,
    VOICE_RUNTIME_TTS_LATENCY_BUDGET_BOUNDS,
    VOICE_RUNTIME_TTS_LATENCY_DEMOTION_THRESHOLD_BOUNDS,
} from '@happier-dev/protocol';

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
        VOICE_RUNTIME_TTS_DEFAULTS.latencyBudgetMs,
        VOICE_RUNTIME_TTS_LATENCY_BUDGET_BOUNDS.min,
        VOICE_RUNTIME_TTS_LATENCY_BUDGET_BOUNDS.max,
    );
}

export function resolveDaemonVoiceInferenceTtsLatencyDemotionThreshold(): number {
    return parseBoundedInt(
        process.env.EXPO_PUBLIC_HAPPIER_VOICE_DAEMON_TTS_LATENCY_DEMOTION_THRESHOLD,
        VOICE_RUNTIME_TTS_DEFAULTS.consecutiveSlowCallsBeforeDemotion,
        VOICE_RUNTIME_TTS_LATENCY_DEMOTION_THRESHOLD_BOUNDS.min,
        VOICE_RUNTIME_TTS_LATENCY_DEMOTION_THRESHOLD_BOUNDS.max,
    );
}

export function resolveDaemonStreamingSttJsonRpcCompatibilityAllowed(): boolean {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_VOICE_DAEMON_STT_JSON_RPC_COMPAT ?? '').trim().toLowerCase();
    return raw !== '0' && raw !== 'false' && raw !== 'forbid' && raw !== 'disabled';
}
