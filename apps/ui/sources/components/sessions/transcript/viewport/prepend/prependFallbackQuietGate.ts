/**
 * Layout-quiet gate for the single prepend fallback write (plan P1).
 *
 * FlashList's MVCP offset correction applies asynchronously (ScrollAnchor.scrollBy → React
 * commit → native maintainVisibleContentPosition contentOffset adjustment), so a conclusive
 * `needs-fallback` observation taken right after commit can race the correction pass: spending
 * the fallback immediately produces a double correction (our write + FlashList's) — the
 * user-visible flicker + shifted position. This gate withholds the single fallback until the
 * anchor row's observed viewport offset is STABLE across one quiet window. It never authorizes
 * more than the transaction's one write (the transaction enforces write-once); it only decides
 * WHEN that write may be spent. The host bounds the whole wait with its one layout timeout.
 */

import { PREPEND_ANCHOR_ALIGNMENT_TOLERANCE_PX } from '@/components/sessions/transcript/viewport/prepend/observePrependOutcome';

/** One quiet window must outlast FlashList's post-correction settle (~1-2 frames + its 100ms ignoreScrollEvents hold). */
export const PREPEND_FALLBACK_QUIET_WINDOW_MS = 120;

export type PrependFallbackQuietDecision =
    | Readonly<{ kind: 'spend' }>
    | Readonly<{ kind: 'wait'; reobserveInMs: number }>;

export type PrependFallbackQuietGate = Readonly<{
    onMisalignedObservation: (observation: Readonly<{
        observedItemOffsetPx: number;
        nowMs: number;
    }>) => PrependFallbackQuietDecision;
}>;

export function createPrependFallbackQuietGate(options?: Readonly<{
    quietWindowMs?: number;
    stabilityTolerancePx?: number;
}>): PrependFallbackQuietGate {
    const quietWindowMs = normalizePositive(options?.quietWindowMs, PREPEND_FALLBACK_QUIET_WINDOW_MS);
    const stabilityTolerancePx = normalizeNonNegative(
        options?.stabilityTolerancePx,
        PREPEND_ANCHOR_ALIGNMENT_TOLERANCE_PX,
    );

    let baseline: { observedItemOffsetPx: number; baselineAtMs: number } | null = null;

    return {
        onMisalignedObservation: (observation) => {
            if (!Number.isFinite(observation.observedItemOffsetPx) || !Number.isFinite(observation.nowMs)) {
                baseline = null;
                return { kind: 'wait', reobserveInMs: quietWindowMs };
            }
            const isStable = baseline != null
                && Math.abs(observation.observedItemOffsetPx - baseline.observedItemOffsetPx) <= stabilityTolerancePx;
            if (!isStable) {
                baseline = {
                    observedItemOffsetPx: observation.observedItemOffsetPx,
                    baselineAtMs: observation.nowMs,
                };
                return { kind: 'wait', reobserveInMs: quietWindowMs };
            }
            const elapsedMs = observation.nowMs - (baseline?.baselineAtMs ?? observation.nowMs);
            if (elapsedMs >= quietWindowMs) {
                return { kind: 'spend' };
            }
            return { kind: 'wait', reobserveInMs: Math.max(1, quietWindowMs - elapsedMs) };
        },
    };
}

function normalizePositive(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
    return Math.trunc(value);
}

function normalizeNonNegative(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
    return value;
}
