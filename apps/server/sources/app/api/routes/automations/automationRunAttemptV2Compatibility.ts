/**
 * The released v2 worker did not return an attempt token after its first
 * claim. Treat its omitted token as attempt one only; the canonical Run
 * owner still rejects it after any reclaim instead of reopening stale work.
 */
export function resolveAutomationRunAttemptV2(attempt: number | undefined): number {
    return attempt ?? 1;
}
