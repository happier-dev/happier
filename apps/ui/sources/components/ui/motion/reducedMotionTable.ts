import { resolveMotionReducedFallback, type MotionSpringRole } from './motionSprings';

/**
 * What every animation this program ships does when the user has asked for reduced motion.
 *
 * **Reduced motion is not a dead interface.** Removing an animation must never remove the fact it
 * was carrying: a status still resolves, a row still arrives, a clock still advances. So each entry
 * names a *mapped* behaviour rather than an on/off switch, and none of them is "nothing happens".
 *
 * **One table, not a conditional per call site.** Before this, `!reducedMotion` was decided
 * independently at the status slot, the focus ring and the elapsed clock, and each one was free to
 * mean something different by it. Ten call sites deciding the same policy is ten chances for the
 * reduced-motion pass to be right in nine places.
 *
 * **The spring-backed rows do not restate the spring table.** They carry a `springRole` and their
 * behaviour is *derived* from `resolveMotionReducedFallback`, which is `motionSprings.ts`'s own
 * decision. That is deliberate: two hand-maintained copies of one policy is exactly the drift this
 * table exists to remove, and `reducedMotionTable.test.ts` asserts the derivation rather than a
 * duplicate of its result.
 *
 * The preference itself is read in one place — `hooks/ui/useReducedMotionPreference.ts` — and
 * passed down. This module never reads it; it answers "given the preference, what does this
 * animation do", which keeps it pure and testable without a renderer.
 */

export const MOTION_ANIMATIONS = [
    /** Press/hover feedback on a touch target. */
    'press',
    /** The keyboard focus indicator appearing and leaving. */
    'focusRing',
    /** A status mark resolving into the next one, in place. */
    'statusSettle',
    /** A row arriving in a list. */
    'rowEnter',
    /** A row leaving a list. */
    'rowExit',
    /** A finished row travelling to another section, and the list re-laying-out around it. */
    'sectionMigration',
    /** The indeterminate running spinner. */
    'spinner',
    /** The once-a-second elapsed clock on a running row. */
    'elapsedTick',
] as const;

export type MotionAnimationId = (typeof MOTION_ANIMATIONS)[number];

/**
 * What an animation actually does right now.
 *
 * - `animate` — full motion. Also the reduced-motion answer for feedback that is not vestibular
 *   travel, where suppressing it would remove the only acknowledgement the user gets.
 * - `settleInstantly` — the end state is applied with no travel. The change still happens and is
 *   still visible; only the journey is removed.
 * - `substitute` — a different, non-moving representation carries the same meaning.
 * - `slowCadence` — a repeating update keeps happening at a calmer interval. Never stopped: a
 *   frozen clock on a running agent would claim the agent had stopped.
 */
export type MotionPresentation = 'animate' | 'settleInstantly' | 'substitute' | 'slowCadence';

type MotionReducedMotionEntry =
    /** Behaviour comes from the spring's own reduced-motion fallback. */
    | Readonly<{ springRole: MotionSpringRole; reduced?: undefined }>
    /** No spring involved (a timing, a CSS rotation, a clock), so the behaviour is stated here. */
    | Readonly<{ springRole: null; reduced: MotionPresentation }>;

const MOTION_REDUCED_MOTION_TABLE = {
    press: { springRole: 'press' },
    statusSettle: { springRole: 'statusSettle' },
    rowEnter: { springRole: 'rowEnter' },
    // Exit rides the same spring as entry: a list whose rows arrive and leave at different speeds
    // reads as two lists.
    rowExit: { springRole: 'rowEnter' },
    sectionMigration: { springRole: 'reflow' },
    // The ring is a timing, not a spring. Under reduced motion it still appears and still leaves —
    // it just stops fading out over 90 ms. An indicator that cannot be seen to arrive is worse than
    // one that arrives abruptly, so this is `settleInstantly`, never `substitute`.
    focusRing: { springRole: null, reduced: 'settleInstantly' },
    // The one substitution in the table: a static glyph replaces the rotation. Freezing the spinner
    // in place instead would leave a ring that reads as a hung process, and hiding it would remove
    // the only sign that work is happening.
    spinner: { springRole: null, reduced: 'substitute' },
    // Kept alive deliberately. C6: with the spinner gone, the advancing clock is the only remaining
    // evidence that a running agent is still running, so reduced motion slows it rather than
    // stopping it. This is the *essential* exception in 4.8, and it is paid for by the cadence drop
    // and by the shared clock's own pause gates (hidden document, backgrounded app).
    elapsedTick: { springRole: null, reduced: 'slowCadence' },
} as const satisfies Record<MotionAnimationId, MotionReducedMotionEntry>;

/**
 * The elapsed clock's two cadences.
 *
 * A minute is the calmest cadence that stays honest for an `m:ss` display: it is slow enough that
 * the value is not a moving object in the corner of the eye, and fast enough that a reader who
 * looks twice sees a different number.
 */
export const MOTION_ELAPSED_TICK_MS = {
    animate: 1_000,
    slowCadence: 60_000,
} as const satisfies Record<'animate' | 'slowCadence', number>;

const SPRING_FALLBACK_PRESENTATION = {
    unchanged: 'animate',
    instant: 'settleInstantly',
} as const;

export function resolveMotionPresentation(
    animation: MotionAnimationId,
    reducedMotion: boolean,
): MotionPresentation {
    if (!reducedMotion) return 'animate';
    const entry = MOTION_REDUCED_MOTION_TABLE[animation];
    if (entry.springRole === null) return entry.reduced;
    return SPRING_FALLBACK_PRESENTATION[resolveMotionReducedFallback(entry.springRole)];
}

/** The spring a given animation rides, or `null` when it is a timing, a rotation or a clock. */
export function resolveMotionAnimationSpringRole(animation: MotionAnimationId): MotionSpringRole | null {
    return MOTION_REDUCED_MOTION_TABLE[animation].springRole;
}

export type ElapsedTickCadence = Readonly<{ intervalMs: number; reducedMotionIntervalMs?: number }>;

const SLOWED_ELAPSED_TICK_CADENCE: ElapsedTickCadence = Object.freeze({
    intervalMs: MOTION_ELAPSED_TICK_MS.animate,
    reducedMotionIntervalMs: MOTION_ELAPSED_TICK_MS.slowCadence,
});
const UNSLOWED_ELAPSED_TICK_CADENCE: ElapsedTickCadence = Object.freeze({
    intervalMs: MOTION_ELAPSED_TICK_MS.animate,
});

/**
 * The elapsed clock's cadence, in the shape `useNowMs` takes.
 *
 * Shaped for that call deliberately: the clock, not the caller, owns the switch between the two
 * cadences, so an elapsed display cannot end up reading the motion preference for itself and
 * disagreeing with this table. Flip the `elapsedTick` row to `animate` and every elapsed display
 * stops slowing down — which is what makes the row load-bearing rather than documentation.
 */
export function resolveElapsedTickCadence(): ElapsedTickCadence {
    return resolveMotionPresentation('elapsedTick', true) === 'slowCadence'
        ? SLOWED_ELAPSED_TICK_CADENCE
        : UNSLOWED_ELAPSED_TICK_CADENCE;
}
