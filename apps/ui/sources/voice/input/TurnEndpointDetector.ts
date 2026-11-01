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

/**
 * Schedules the hands-free end-of-turn once the recognizer reports end of speech. Returns a cancel
 * function; the callback never fires after cancellation.
 */
function scheduleTurnEndpoint(params: {
    policy: TurnEndpointPolicy;
    speechElapsedMs: number;
    onEndpoint: () => void;
}): () => void {
    let cancelled = false;
    const fire = () => {
        if (cancelled) return;
        cancelled = true;
        params.onEndpoint();
    };
    const waitMs = computeTurnEndpointDelayMs(params.policy, params.speechElapsedMs);
    if (waitMs <= 0) {
        queueMicrotask(fire);
        return () => {
            cancelled = true;
        };
    }
    const timer = setTimeout(fire, waitMs);
    return () => {
        cancelled = true;
        clearTimeout(timer);
    };
}

export type TurnEndpointDetector = Readonly<{
    observe: (result: Readonly<{
        transcript: string;
        isEndpoint: boolean;
        policy: TurnEndpointPolicy;
        speechElapsedMs: number;
    }>) => void;
    cancel: () => void;
}>;

/** One capture's endpoint: resumed speech cancels the wait; later silence does not. */
export function createTurnEndpointDetector(params: {
    onEndpoint: () => void;
}): TurnEndpointDetector {
    let transcript = '';
    let cancelPending: (() => void) | null = null;

    const cancel = () => {
        cancelPending?.();
        cancelPending = null;
    };

    return {
        cancel,
        observe: (result) => {
            const text = result.transcript.trim();
            if (text && text !== transcript) {
                transcript = text;
                cancel();
            }
            if (!result.isEndpoint || !transcript || cancelPending) return;

            // A native endpoint is a one-shot signal after stream reset. It may carry the
            // last words, so a changed transcript can cancel an old wait and arm this one.
            cancelPending = scheduleTurnEndpoint({
                policy: result.policy,
                speechElapsedMs: result.speechElapsedMs,
                onEndpoint: () => {
                    cancelPending = null;
                    params.onEndpoint();
                },
            });
        },
    };
}
