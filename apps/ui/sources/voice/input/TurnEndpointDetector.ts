export type TurnEndpointPolicy = Readonly<{
    silenceMs: number;
    minSpeechMs: number;
}>;

function clampBoundedMs(value: unknown): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
    return Math.max(0, Math.min(5_000, n));
}

export function normalizeTurnEndpointPolicy(raw: {
    silenceMs?: unknown;
    minSpeechMs?: unknown;
}): TurnEndpointPolicy {
    return {
        silenceMs: clampBoundedMs(raw.silenceMs),
        minSpeechMs: clampBoundedMs(raw.minSpeechMs),
    };
}

export function computeTurnEndpointDelayMs(policy: TurnEndpointPolicy, speechElapsedMs: number): number {
    const elapsed = Math.max(0, Number.isFinite(speechElapsedMs) ? speechElapsedMs : 0);
    return Math.max(policy.silenceMs, policy.minSpeechMs - elapsed, 0);
}
