/**
 * Whether a stable paint is trustworthy enough to remember as this session's warm geometry.
 *
 * Remembering it is what lets the NEXT open of the same session skip the first-paint
 * placeholder, so this predicate decides whether warm re-entry is fast or slow.
 *
 * It used to require `nativeViewportObserved`. Measured on device 2026-08-19, navigating between
 * already-loaded sessions with the cockpit swipe: that signal is `0` on this path and the stable
 * paint is released by mount settle instead — so nothing was ever recorded, the warm cache held
 * a single entry from an unrelated list tap, `isWarmKeepAliveInstance` was permanently false,
 * and the instant-reveal branch was unreachable. Every swipe showed a placeholder for ~1.3-1.5s
 * while the data had been ready at ~150ms. The optimisation could not even bootstrap itself,
 * because the only way to become warm was a signal that never arrived.
 *
 * Mount settle is an equally real settle: the coordinator declares geometry quiescent only after
 * a quiet window with first paint and layout commit observed. What must NOT be recorded is a
 * paint released because the deadline expired — that is the gate giving up on a signal, not
 * geometry that settled, and trusting it would let a genuinely unsettled transcript claim to be
 * warm and reveal at the wrong offset next time.
 */
export function resolveTranscriptWarmPaintRecordable(input: Readonly<{
    nativeViewportObserved: boolean;
    nativeMountSettleStable: boolean;
    nativeMountSettleDeadlineReached: boolean;
}>): boolean {
    // The deadline is "stop waiting", never "this is settled".
    if (input.nativeMountSettleDeadlineReached) return false;
    return input.nativeViewportObserved || input.nativeMountSettleStable;
}
