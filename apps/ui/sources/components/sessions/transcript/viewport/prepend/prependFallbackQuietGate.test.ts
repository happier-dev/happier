import { describe, expect, it } from 'vitest';

import {
    PREPEND_FALLBACK_QUIET_WINDOW_MS,
    createPrependFallbackQuietGate,
} from './prependFallbackQuietGate';

describe('prepend fallback quiet gate (plan P1)', () => {
    it('waits one full quiet window after the first misaligned observation', () => {
        const gate = createPrependFallbackQuietGate();

        expect(gate.onMisalignedObservation({ observedItemOffsetPx: 240, nowMs: 1_000 })).toEqual({
            kind: 'wait',
            reobserveInMs: PREPEND_FALLBACK_QUIET_WINDOW_MS,
        });
    });

    it('spends the fallback when the misalignment is stable across the quiet window', () => {
        const gate = createPrependFallbackQuietGate();

        gate.onMisalignedObservation({ observedItemOffsetPx: 240, nowMs: 1_000 });
        expect(gate.onMisalignedObservation({
            observedItemOffsetPx: 241,
            nowMs: 1_000 + PREPEND_FALLBACK_QUIET_WINDOW_MS,
        })).toEqual({ kind: 'spend' });
    });

    it('keeps waiting for the remaining window when a stable observation arrives early', () => {
        const gate = createPrependFallbackQuietGate({ quietWindowMs: 100 });

        gate.onMisalignedObservation({ observedItemOffsetPx: 240, nowMs: 1_000 });
        expect(gate.onMisalignedObservation({ observedItemOffsetPx: 240, nowMs: 1_040 })).toEqual({
            kind: 'wait',
            reobserveInMs: 60,
        });
        // The early stable observation does NOT reset the window.
        expect(gate.onMisalignedObservation({ observedItemOffsetPx: 240, nowMs: 1_100 })).toEqual({
            kind: 'spend',
        });
    });

    it('re-baselines when the observed offset moves beyond tolerance (FlashList correction still landing)', () => {
        const gate = createPrependFallbackQuietGate({ quietWindowMs: 100, stabilityTolerancePx: 4 });

        gate.onMisalignedObservation({ observedItemOffsetPx: 900, nowMs: 1_000 });
        // The async MVCP correction shifts the anchor between observations: not quiet yet.
        expect(gate.onMisalignedObservation({ observedItemOffsetPx: 240, nowMs: 1_120 })).toEqual({
            kind: 'wait',
            reobserveInMs: 100,
        });
        // Stable from the new baseline → spend after one quiet window.
        expect(gate.onMisalignedObservation({ observedItemOffsetPx: 242, nowMs: 1_220 })).toEqual({
            kind: 'spend',
        });
    });

    it('treats exactly-at-tolerance and exactly-at-window boundaries as stable/elapsed', () => {
        const gate = createPrependFallbackQuietGate({ quietWindowMs: 100, stabilityTolerancePx: 4 });

        gate.onMisalignedObservation({ observedItemOffsetPx: 240, nowMs: 0 });
        expect(gate.onMisalignedObservation({ observedItemOffsetPx: 244, nowMs: 100 })).toEqual({
            kind: 'spend',
        });
    });

    it('re-baselines on a non-finite observation instead of spending', () => {
        const gate = createPrependFallbackQuietGate({ quietWindowMs: 100 });

        gate.onMisalignedObservation({ observedItemOffsetPx: 240, nowMs: 0 });
        expect(gate.onMisalignedObservation({ observedItemOffsetPx: Number.NaN, nowMs: 100 })).toEqual({
            kind: 'wait',
            reobserveInMs: 100,
        });
        expect(gate.onMisalignedObservation({ observedItemOffsetPx: 240, nowMs: 150 })).toEqual({
            kind: 'wait',
            reobserveInMs: 100,
        });
    });
});
