import type { TokenUsageTone } from '@/components/sessions/usage/tokenUsageTone';

/**
 * Pure gauge math. Every function carries a `'worklet'` directive so the same
 * canonical logic runs inside Reanimated worklets (fill sweeps, threshold
 * reactions) and on the JS thread.
 *
 * Tone thresholds mirror `sessions/agentInput/contextWarning.ts` (out of this
 * lane's write scope), which keys on REMAINING context: ≤5% remaining → danger,
 * ≤10% remaining → warn. Expressed here as USED percentage: ≥95 danger, ≥90 warn.
 * If contextWarning's thresholds ever change, change these with them (L5 owns
 * unifying the two files into one import).
 */

export type UsageTone = 'ok' | 'warn' | 'danger';

export const CONTEXT_USAGE_WARN_THRESHOLD_PCT = 90;
export const CONTEXT_USAGE_DANGER_THRESHOLD_PCT = 95;

/** Attention thresholds that fire a one-shot haptic tick + pulse when crossed upward. */
export const GAUGE_HAPTIC_THRESHOLDS_PCT = [75, 90] as const;

export function clampUsedPct(pct: number): number {
    'worklet';
    if (Number.isNaN(pct)) return 0;
    if (pct <= 0) return 0;
    if (pct >= 100) return 100;
    return pct;
}

export function resolveUsageTone(usedPct: number): UsageTone {
    'worklet';
    if (usedPct >= CONTEXT_USAGE_DANGER_THRESHOLD_PCT) return 'danger';
    if (usedPct >= CONTEXT_USAGE_WARN_THRESHOLD_PCT) return 'warn';
    return 'ok';
}

/** Bridge to the canonical `TokenUsageTone` vocabulary used by `resolveTokenUsageToneColor`. */
export function usageToneToTokenUsageTone(tone: UsageTone): TokenUsageTone {
    'worklet';
    if (tone === 'danger') return 'critical';
    if (tone === 'warn') return 'warning';
    return 'neutral';
}

export type RingGeometry = Readonly<{ radius: number; circumference: number }>;

export function ringGeometry(size: number, strokeWidth: number): RingGeometry {
    'worklet';
    const radius = (size - strokeWidth) / 2;
    return { radius, circumference: 2 * Math.PI * radius };
}

/** SVG dash offset for a used percentage: 0% → full offset (empty), 100% → 0 (full sweep). */
export function sweepDashOffset(circumference: number, usedPct: number): number {
    'worklet';
    return circumference * (1 - clampUsedPct(usedPct) / 100);
}

/**
 * Returns the HIGHEST haptic threshold crossed by an upward move from
 * `prevPct` to `nextPct`, or null when none was crossed (or moving down).
 */
export function crossedHapticThreshold(prevPct: number, nextPct: number): number | null {
    'worklet';
    if (nextPct <= prevPct) return null;
    let crossed: number | null = null;
    for (const threshold of GAUGE_HAPTIC_THRESHOLDS_PCT) {
        if (prevPct < threshold && nextPct >= threshold) crossed = threshold;
    }
    return crossed;
}
