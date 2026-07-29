/**
 * TTS playback timing — the canonical owner of "how long has the assistant
 * actually been speaking" for the local voice path.
 *
 * Previously the engine kept an ad-hoc `bargeInSpeakingStartedAt` wall-clock
 * solely for the barge-in protected-head window. The played-position needed for
 * protected-head decision is the confirmed-played duration since the
 * assistant's audio started, so the engine drives `markStarted()` from the
 * playback layer's `onSpeaking` signal and reads `playedMs()` at interrupt.
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
     * so the protected head does not suppress a genuine barge-in.
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
