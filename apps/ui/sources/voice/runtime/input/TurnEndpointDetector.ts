export type TurnEndpointPolicy = Readonly<{
    silenceMs: number;
    minSpeechMs: number;
}>;

/** setTimeout uses a signed 32-bit millisecond delay on supported JS hosts. */
export const MAX_VOICE_TIMER_DELAY_MS = 2_147_483_647;

function clampBoundedMs(value: unknown): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
    return Math.max(0, Math.min(MAX_VOICE_TIMER_DELAY_MS, n));
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
