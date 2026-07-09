/**
 * TTS playback timing — the canonical owner of "how long has the assistant
 * actually been speaking" for the local voice path.
 *
 * Previously the engine kept an ad-hoc `bargeInSpeakingStartedAt` wall-clock
 * solely for the barge-in protected-head window. The played-position needed for
 * played-ms truncation is the SAME quantity (confirmed-played duration since the
 * assistant's audio started), so it lives here as a single owner rather than a
 * second timer: the engine drives `markStarted()` from the playback layer's
 * `onSpeaking` signal and reads `playedMs()` at interrupt.
 */
export type TtsPlaybackClock = Readonly<{
    /** Record that confirmed playback started (driven by the `onSpeaking` signal). */
    markStarted: (at?: number) => void;
    /** Clear the speaking window (driven by `onTtsStopped`/clean completion). */
    reset: () => void;
    /** Whether a speaking window is currently open. */
    isStarted: () => boolean;
    /**
     * Confirmed-played duration in ms at `at` (defaults to now). When no speaking
     * window is open the played position is unknown, so this returns
     * `Number.MAX_SAFE_INTEGER` — callers treat "unknown" as "past any boundary"
     * (the protected head must not suppress a genuine barge-in, and truncation
     * must not trim a turn whose start we never observed).
     */
    playedMs: (at?: number) => number;
}>;

export function createTtsPlaybackClock(nowMs: () => number = () => Date.now()): TtsPlaybackClock {
    let startedAtMs: number | null = null;
    return {
        markStarted: (at) => {
            startedAtMs = typeof at === 'number' && Number.isFinite(at) ? at : nowMs();
        },
        reset: () => {
            startedAtMs = null;
        },
        isStarted: () => startedAtMs !== null,
        playedMs: (at) => {
            if (startedAtMs === null) return Number.MAX_SAFE_INTEGER;
            const now = typeof at === 'number' && Number.isFinite(at) ? at : nowMs();
            return Math.max(0, now - startedAtMs);
        },
    };
}

/**
 * Rough average speaking rate used to estimate the full spoken duration of a
 * turn from its text length. Device/neural TTS engines do not report the total
 * duration up front, so the played-ms truncation needs an estimate of how long
 * the whole turn would take to speak in order to turn an elapsed played-ms into
 * a text fraction. ~60 ms/char ≈ 16 chars/s ≈ a natural ~160 wpm.
 */
export const TTS_ESTIMATED_MS_PER_CHAR = 60;

/**
 * Estimate the full duration (ms) to speak `text` at the average rate above.
 * Returns 0 for empty text so the truncation seam short-circuits to the full
 * (empty) text rather than dividing by zero.
 */
export function estimateSpokenDurationMs(
    text: string,
    msPerChar: number = TTS_ESTIMATED_MS_PER_CHAR,
): number {
    const length = typeof text === 'string' ? text.trim().length : 0;
    if (length <= 0) return 0;
    return length * Math.max(1, msPerChar);
}
