import { describe, expect, it } from 'vitest';

import { resolveTranscriptWarmPaintRecordable } from './resolveTranscriptWarmPaintRecordable';

/**
 * A session can only become "warm" if something records that it painted.
 *
 * Measured on device 2026-08-19 while navigating between already-loaded sessions with the
 * cockpit swipe: `nativeViewportObserved` is 0 on that path, the stable paint is released by
 * mount settle, and recording was gated on the viewport signal alone — so the warm cache stayed
 * empty for every swiped-to session, `isWarmKeepAliveInstance` was always false, and the
 * instant-reveal branch never ran. The user saw a placeholder for ~1.3-1.5s on a transcript
 * whose data was ready at ~150ms, and it never improved with repetition because the fast path
 * had no way to bootstrap itself.
 */

const base = {
    nativeViewportObserved: false,
    nativeMountSettleStable: false,
    nativeMountSettleDeadlineReached: false,
} as const;

describe('transcript warm paint recordability', () => {
    it('records a paint released by an observed native viewport', () => {
        expect(resolveTranscriptWarmPaintRecordable({
            ...base,
            nativeViewportObserved: true,
        })).toBe(true);
    });

    it('records a paint released by mount settle, which is how the swipe path settles', () => {
        // The case that was missing entirely, and the reason warm re-entry never engaged.
        expect(resolveTranscriptWarmPaintRecordable({
            ...base,
            nativeMountSettleStable: true,
        })).toBe(true);
    });

    it('refuses a paint that only happened because the deadline expired', () => {
        // The deadline means "stop waiting", not "geometry settled". Recording it would let an
        // unsettled transcript claim to be warm and reveal at the wrong offset next time.
        expect(resolveTranscriptWarmPaintRecordable({
            ...base,
            nativeMountSettleDeadlineReached: true,
        })).toBe(false);
    });

    it('still refuses when the deadline expired even if settle later reported stable', () => {
        expect(resolveTranscriptWarmPaintRecordable({
            nativeViewportObserved: true,
            nativeMountSettleStable: true,
            nativeMountSettleDeadlineReached: true,
        })).toBe(false);
    });

    it('records nothing when no settle signal arrived at all', () => {
        expect(resolveTranscriptWarmPaintRecordable(base)).toBe(false);
    });
});
