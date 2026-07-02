export type WaitForVisualUpdateOutcome = 'completed' | 'timed-out';

export type WaitForVisualUpdateWithTimeoutInput = Readonly<{
    /** rAF-backed pacing wait (e.g. ChatList/ChainTranscriptList `waitForNextVisualUpdate`). */
    waitForNextVisualUpdate: () => Promise<void> | void;
    /** Upper bound before falling back; non-finite or negative values mean an immediate fallback. */
    timeoutMs: number;
}>;

/**
 * Races an injected `waitForNextVisualUpdate`-style pacing wait against a
 * timer fallback so rAF starvation (background tabs throttle/stop rAF,
 * evidence E10) can never stall callers such as the transcript initial-fill
 * loop. Rejections and synchronous throws from the injected fn resolve as
 * 'completed' — this is a pacing primitive, not a correctness gate.
 */
export function waitForVisualUpdateWithTimeout(input: WaitForVisualUpdateWithTimeoutInput): Promise<WaitForVisualUpdateOutcome> {
    const timeoutMs = Number.isFinite(input.timeoutMs) ? Math.max(0, Math.trunc(input.timeoutMs)) : 0;

    return new Promise<WaitForVisualUpdateOutcome>((resolve) => {
        let settled = false;
        const timeoutId = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve('timed-out');
        }, timeoutMs);

        const settleCompleted = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            resolve('completed');
        };

        void Promise.resolve()
            .then(() => input.waitForNextVisualUpdate())
            .then(settleCompleted, settleCompleted);
    });
}
