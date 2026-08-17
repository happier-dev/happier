/**
 * The arrival gesture — what the planet does while Voice is *starting*.
 *
 * §2.4a splits ambient motion in two, and the split is the whole point:
 * respiration means **the microphone is open and listening**, so it must not
 * begin before that is true. The runtime spends a real interval in
 * `connecting` / `acquiring_mic` where the attempt exists and the microphone
 * does not, and something has to say "Voice is starting" during it. That is
 * this: **one bounded swell**, played once, that returns to rest and stays
 * there for however long the connect takes.
 *
 * Bounded is not a stylistic preference. A gesture that repeats is respiration
 * wearing a different name, and respiration before capture is exactly the lie
 * this curve exists to replace — so the envelope is zero outside its window by
 * construction rather than by a timer someone has to remember to stop.
 *
 * The shape reuses the vocabulary of `breathe()`: a quick ease-out rise, then a
 * longer ease-in-out settle. Symmetry would read as a pulse — the same reason
 * the respiration curve is asymmetric.
 */

/** Total length of the gesture. Long enough to be read, short enough to end. */
export const ARRIVAL_SECONDS = 1.25;

/** Fraction of the gesture spent rising. Front-loaded: it arrives, then settles. */
const ARRIVAL_RISE = 0.32;

export function arrivalGesture(seconds: number): number {
    'worklet';
    if (!(seconds > 0) || seconds >= ARRIVAL_SECONDS) return 0;
    const u = seconds / ARRIVAL_SECONDS;
    if (u < ARRIVAL_RISE) {
        const rise = u / ARRIVAL_RISE;
        return 1 - (1 - rise) * (1 - rise);
    }
    const fall = (u - ARRIVAL_RISE) / (1 - ARRIVAL_RISE);
    return 1 - (fall < 0.5 ? 2 * fall * fall : 1 - Math.pow(-2 * fall + 2, 2) / 2);
}
