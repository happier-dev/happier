/**
 * The one falloff curve behind a progressive scrim.
 *
 * A scrim that veils the surface it sits under and clears toward the top has to agree with itself:
 * the dim ramp and every blur layer's mask are the same curve sampled differently. Deriving them
 * from one function is what stops the dim and the frost fading out at visibly different rates.
 *
 * `t` runs 0 at the anchored edge (the composer) to 1 at the far end of the ramp.
 */

/**
 * Ease-out: full strength at the anchored edge, dissolving quickly and then trailing off.
 *
 * The exponent is the whole design decision. 1.0 is a linear ramp, which bands visibly across a
 * large soft gradient; higher values clear the far end sooner. ~2.2 reads as "heavy at the composer,
 * gone by the middle of the screen" without a hard edge.
 */
const FALLOFF_EXPONENT = 2.2;

/**
 * Number of colour stops used to describe the ramp.
 *
 * Two stops is the obvious encoding and the wrong one: a long two-stop gradient over a dark ground
 * shows Mach banding. More stops let the platform interpolate in shorter segments, which costs
 * nothing (the layer rasterises once at a fixed size) and removes the banding. `react-native-svg`'s
 * `FeTurbulence` is unimplemented at 15.x, so the usual "dither it with noise" fix is unavailable.
 */
const DEFAULT_STOP_COUNT = 12;

export function scrimFalloff(t: number): number {
    const clamped = Math.min(1, Math.max(0, t));
    return Math.pow(1 - clamped, FALLOFF_EXPONENT);
}

/**
 * At least two entries, which is what `expo-linear-gradient` requires of `colors`/`locations`.
 * Expressed in the type so callers do not have to assert it at every call site.
 */
export type ScrimRamp = Readonly<{
    /** Gradient stop positions, 0 at the anchored edge to 1 at the far end. */
    locations: readonly [number, number, ...number[]];
    /** Strength at each stop, 1 at the anchored edge to 0 at the far end. */
    alphas: readonly [number, number, ...number[]];
}>;

export function scrimRamp(stopCount: number = DEFAULT_STOP_COUNT): ScrimRamp {
    const count = Math.max(2, Math.floor(stopCount));
    const locations: number[] = [];
    const alphas: number[] = [];
    for (let index = 0; index < count; index += 1) {
        const t = index / (count - 1);
        locations.push(t);
        alphas.push(scrimFalloff(t));
    }
    // `count` is clamped to >= 2 above, so both arrays satisfy the tuple shape.
    return {
        locations: locations as unknown as ScrimRamp['locations'],
        alphas: alphas as unknown as ScrimRamp['alphas'],
    };
}

/**
 * The mask for one layer of a stacked progressive blur.
 *
 * Each layer holds a constant blur radius and is revealed only over the band where that radius is
 * the right one, so the composite reads as a blur that weakens with distance. Bands overlap
 * deliberately: abutting them exactly leaves a visible seam where one radius stops and the next
 * begins, because the two layers are different images rather than two samples of one.
 *
 * Layer 0 is the strongest and sits nearest the anchored edge.
 */
export function scrimMaskBand(layerIndex: number, layerCount: number): ScrimRamp {
    const count = Math.max(1, Math.floor(layerCount));
    const index = Math.min(Math.max(0, Math.floor(layerIndex)), count - 1);
    const bandSize = 1 / count;
    // Wide on purpose. A narrow overlap leaves each layer's edge visible as a faint line where
    // one blur radius gives way to the next; more than half the band makes the handover read as
    // one continuous falloff.
    const overlap = bandSize * 0.6;

    const bandEnd = Math.min(1, (index + 1) * bandSize + overlap);
    // Every layer is fully opaque from the anchored edge to its own band, then falls away. Stacking
    // them that way means the strongest layer is never revealed BENEATH a weaker one, which would
    // wash the strong blur out instead of deepening it.
    return {
        locations: [0, Math.max(0, bandEnd - overlap), bandEnd, 1] as const,
        alphas: [1, 1, 0, 0] as const,
    };
}
