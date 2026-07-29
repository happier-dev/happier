/**
 * Generic latest-wins concurrency guard.
 *
 * A tiny token guard for async lifecycles where only the most recent attempt
 * should be allowed to commit its result:
 * - `next()` starts a new attempt, invalidating any prior in-flight attempt, and
 *   returns its token.
 * - `cancel()` invalidates the current attempt without starting a new one.
 * - `isCurrent(token)` reports whether `token` is still the active attempt.
 * - `assertCurrent(token)` throws {@link AttemptCancelledError} when `token` is
 *   stale, so callers can `await` work and bail out after the await.
 *
 * This is a cross-cutting primitive (not voice-specific): use it whenever the
 * intent is "ignore a stale completion". For true in-flight I/O cancellation
 * (aborting a fetch/stream) use an `AbortController`/abort racer instead — the
 * two are complementary, not interchangeable.
 *
 * Mirrors the proven latest-wins guard shape from the reference implementation.
 */
export class AttemptCancelledError extends Error {
    constructor(message = 'Attempt cancelled') {
        super(message);
        this.name = 'AttemptCancelledError';
    }
}

export type AttemptToken = number;

export type AttemptGuard = Readonly<{
    next: () => AttemptToken;
    cancel: () => void;
    isCurrent: (token: AttemptToken) => boolean;
    assertCurrent: (token: AttemptToken) => void;
}>;

export function createAttemptGuard(): AttemptGuard {
    let attemptId: AttemptToken = 0;

    return {
        next: () => {
            attemptId += 1;
            return attemptId;
        },
        cancel: () => {
            attemptId += 1;
        },
        isCurrent: (token: AttemptToken) => token === attemptId,
        assertCurrent: (token: AttemptToken) => {
            if (token !== attemptId) {
                throw new AttemptCancelledError();
            }
        },
    };
}
