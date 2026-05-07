import { describe, expect, it } from 'vitest';
import {
    evaluateSafeCursorLagTripwire,
    rememberBlockedCursorLag,
    type SafeCursorLagTripwireState,
} from './safeCursorLagTripwire';

describe('safe cursor lag tripwire', () => {
    it('emits only after the same blocked cursor exceeds the threshold on two checks', () => {
        let state: SafeCursorLagTripwireState | null = rememberBlockedCursorLag(null, {
            blockedCursor: 'cursor-2',
            blockedReason: 'unsupported-kind',
            safeAdvanceCursor: 'cursor-1',
            nowMs: 1_000,
        });

        let evaluation = evaluateSafeCursorLagTripwire(state, { nowMs: 1_500, alertMs: 1_000 });
        expect(evaluation.event).toBeNull();
        state = evaluation.state;

        evaluation = evaluateSafeCursorLagTripwire(state, { nowMs: 2_001, alertMs: 1_000 });
        expect(evaluation.event).toBeNull();
        state = evaluation.state;

        evaluation = evaluateSafeCursorLagTripwire(state, { nowMs: 2_500, alertMs: 1_000 });
        expect(evaluation.event).toEqual({
            blockedCursor: 'cursor-2',
            blockedReason: 'unsupported-kind',
            safeAdvanceCursor: 'cursor-1',
            lagMs: 1_500,
            consecutiveOverThresholdTicks: 2,
        });
        state = evaluation.state;

        evaluation = evaluateSafeCursorLagTripwire(state, { nowMs: 3_500, alertMs: 1_000 });
        expect(evaluation.event).toBeNull();
    });

    it('resets the lag window when a different cursor blocks', () => {
        let state: SafeCursorLagTripwireState | null = rememberBlockedCursorLag(null, {
            blockedCursor: 'cursor-2',
            blockedReason: 'unsupported-kind',
            safeAdvanceCursor: 'cursor-1',
            nowMs: 1_000,
        });
        state = evaluateSafeCursorLagTripwire(state, { nowMs: 2_100, alertMs: 1_000 }).state;

        state = rememberBlockedCursorLag(state, {
            blockedCursor: 'cursor-3',
            blockedReason: 'pending-materialization',
            safeAdvanceCursor: 'cursor-2',
            nowMs: 2_200,
        });

        const evaluation = evaluateSafeCursorLagTripwire(state, { nowMs: 3_100, alertMs: 1_000 });
        expect(evaluation.event).toBeNull();
        expect(evaluation.state?.blockedCursor).toBe('cursor-3');
        expect(evaluation.state?.consecutiveOverThresholdTicks).toBe(0);
    });
});
