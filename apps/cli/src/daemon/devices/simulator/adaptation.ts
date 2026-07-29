/**
 * Adaptive-bitrate computation for the Android scrcpy server-restart producer.
 *
 * scrcpy runs in `raw_stream=true` mode, so the encoder bitrate/fps/resolution are fixed at
 * server launch and can only change by restarting the server with new args. That restart is
 * expensive (it tears down and re-establishes the stream), so this controller is deliberately
 * conservative: it watches observed throughput and backpressure (frames dropped, transport
 * cap breaches) and produces a *target* bitrate that the restart producer applies via
 * `set_quality` ONLY when the delta is significant. This avoids thrashing the encoder.
 *
 * This is the canonical owner the FINALIZATION plan cited as `adaptation.ts` (finding #41).
 * The earlier lane found no file existed; this de-phantoms it with a real, tested controller.
 *
 * The controller is pure with respect to I/O: callers feed it observed window stats via
 * `observe(...)` and act on the returned `targetBitrateBps` / `shouldApply`. It owns no timers,
 * sockets, or process handles.
 */

export type SimulatorBitrateAdaptationBounds = Readonly<{
    initialBitrateBps: number;
    minBitrateBps: number;
    maxBitrateBps: number;
}>;

export type SimulatorBitrateAdaptationObservation = Readonly<{
    nowMs: number;
    /** Bytes successfully delivered to the viewer in this window. */
    deliveredBytes: number;
    /** Bytes dropped (buffer overflow / cap breach) in this window. */
    droppedBytes: number;
    /** Whether the transport reported backpressure (a paused/capped receipt) in this window. */
    backpressure: boolean;
}>;

export type SimulatorBitrateAdaptationResult = Readonly<{
    targetBitrateBps: number;
    /** True when the target crossed the significant-change threshold vs the last APPLIED target. */
    shouldApply: boolean;
}>;

export type SimulatorBitrateAdaptationController = Readonly<{
    currentTargetBitrateBps: () => number;
    observe: (observation: SimulatorBitrateAdaptationObservation) => SimulatorBitrateAdaptationResult;
    /** Mark the current target as applied so subsequent `shouldApply` deltas measure from here. */
    markApplied: () => void;
    reset: () => void;
}>;

// True AIMD: multiplicative DECREASE on congestion (fast back-off), ADDITIVE INCREASE on recovery
// (fixed linear step, never a geometric ramp). Multiplying the target on every clean window (the
// prior `* 1.1`) is MIMD and ramps geometrically straight back into congestion.
const BACKPRESSURE_DECREASE_FACTOR = 0.7;
// Fixed additive increase applied once per recovery, as a fraction of the configured bitrate span.
// A linear step keeps recovery probing (one rung at a time) instead of compounding.
const ADDITIVE_INCREASE_RATIO_OF_SPAN = 0.1;
// A restart is only worth doing when the encoder bitrate would move by at least this fraction.
const SIGNIFICANT_CHANGE_RATIO = 0.2;
// Number of consecutive clean windows required before recovering, to damp recovery oscillation.
const CLEAN_WINDOWS_BEFORE_RECOVERY = 3;

export const DEFAULT_SIMULATOR_BITRATE_ADAPTATION_BOUNDS: SimulatorBitrateAdaptationBounds = {
    initialBitrateBps: 4_000_000,
    minBitrateBps: 800_000,
    maxBitrateBps: 8_000_000,
};

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function dropRatio(observation: SimulatorBitrateAdaptationObservation): number {
    const total = observation.deliveredBytes + observation.droppedBytes;
    if (total <= 0) return 0;
    return observation.droppedBytes / total;
}

export function createSimulatorBitrateAdaptationController(
    bounds: SimulatorBitrateAdaptationBounds = DEFAULT_SIMULATOR_BITRATE_ADAPTATION_BOUNDS,
): SimulatorBitrateAdaptationController {
    const minBitrateBps = Math.max(1, Math.floor(bounds.minBitrateBps));
    const maxBitrateBps = Math.max(minBitrateBps, Math.floor(bounds.maxBitrateBps));
    const initialBitrateBps = clamp(Math.floor(bounds.initialBitrateBps), minBitrateBps, maxBitrateBps);
    // Fixed additive step (in bps), derived from the configured span. At least 1 bps so the increase
    // always makes forward progress even for a degenerate span.
    const additiveIncreaseStepBps = Math.max(
        1,
        Math.floor((maxBitrateBps - minBitrateBps) * ADDITIVE_INCREASE_RATIO_OF_SPAN),
    );

    let target = initialBitrateBps;
    let lastAppliedTarget = initialBitrateBps;
    let cleanWindowStreak = 0;

    const significantChange = (next: number): boolean => {
        const delta = Math.abs(next - lastAppliedTarget);
        return delta >= lastAppliedTarget * SIGNIFICANT_CHANGE_RATIO;
    };

    return {
        currentTargetBitrateBps: () => target,
        observe: (observation) => {
            const congested = observation.backpressure || dropRatio(observation) >= 0.1;
            if (congested) {
                cleanWindowStreak = 0;
                target = clamp(Math.floor(target * BACKPRESSURE_DECREASE_FACTOR), minBitrateBps, maxBitrateBps);
            } else {
                cleanWindowStreak += 1;
                if (cleanWindowStreak >= CLEAN_WINDOWS_BEFORE_RECOVERY) {
                    // ADDITIVE increase: one fixed linear step, then RESET the streak so the next step
                    // requires a fresh run of clean windows. Without the reset, every subsequent clean
                    // window re-triggered an increase — a geometric ramp straight back into congestion.
                    target = clamp(target + additiveIncreaseStepBps, minBitrateBps, maxBitrateBps);
                    cleanWindowStreak = 0;
                }
            }
            return {
                targetBitrateBps: target,
                shouldApply: significantChange(target),
            };
        },
        markApplied: () => {
            lastAppliedTarget = target;
        },
        reset: () => {
            target = initialBitrateBps;
            lastAppliedTarget = initialBitrateBps;
            cleanWindowStreak = 0;
        },
    };
}
