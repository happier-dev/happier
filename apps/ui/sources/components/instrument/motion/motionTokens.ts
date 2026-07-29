/**
 * Instrument-kit motion grammar — the ONE place spring families, entrance
 * durations, and stagger constants are defined. Every kit component imports
 * these; nothing hand-rolls a spring config. See `../README.md` for the rules.
 *
 * Binding grammar (L4): one spring family (`standard`, `snappy`); entrance
 * animations play ONCE per mount at 300–450ms; the only looping animation is
 * the streaming shimmer (which pauses when not streaming / app inactive);
 * stagger step 40–60ms capped at 8 items.
 */

/** Reanimated `withSpring` config shape (subset we set explicitly). */
export type SpringConfig = Readonly<{
    damping: number;
    stiffness: number;
    mass: number;
}>;

/**
 * Signature spring family. `standard` for fills/positions/number rolls;
 * `snappy` for press feedback and small state flips.
 */
export const INSTRUMENT_SPRINGS = {
    standard: { damping: 22, stiffness: 180, mass: 1 },
    snappy: { damping: 26, stiffness: 320, mass: 1 },
} as const satisfies Record<'standard' | 'snappy', SpringConfig>;

export type InstrumentSpringName = keyof typeof INSTRUMENT_SPRINGS;

/** Entrance timings (ms). Entrances run once per mount. */
export const INSTRUMENT_DURATIONS = {
    /** Default entrance for a single element (within the 300–450ms band). */
    entrance: 360,
    /** Slightly longer entrance for hero/display elements. */
    entranceEmphasis: 440,
    /** Crossfade used at `minimal` level (and OS reduce-motion) — no travel. */
    crossfadeMinimal: 150,
    /** Single value-change tint flash / emphasis pulse. */
    pulse: 220,
} as const;

/** Stagger constants for grouped entrances. */
export const INSTRUMENT_STAGGER = {
    /** Delay step between staggered siblings (ms). */
    stepMs: 50,
    /** Hard cap on staggered items — beyond this, entrance no longer waits. */
    maxItems: 8,
} as const;

/**
 * Resolve the entrance delay for the nth staggered sibling, capped so a long
 * list never accumulates an unbounded wait.
 */
export function staggerDelayForIndex(index: number): number {
    if (!Number.isFinite(index) || index <= 0) return 0;
    const capped = Math.min(Math.floor(index), INSTRUMENT_STAGGER.maxItems - 1);
    return capped * INSTRUMENT_STAGGER.stepMs;
}

/** Press-feedback scale (matches the design-engineering 0.96 floor). */
export const INSTRUMENT_PRESS_SCALE = 0.96;

/**
 * Streaming shimmer cadence. Amplitude/opacity are component-local; this is the
 * shared period so every streaming surface breathes in sync.
 */
export const INSTRUMENT_SHIMMER = {
    /** One shimmer cycle (ms) — slow, ambient, ~0.4Hz meniscus family. */
    periodMs: 2400,
} as const;
