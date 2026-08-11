import { ReduceMotion, type WithSpringConfig } from 'react-native-reanimated';

/**
 * The app's spring vocabulary: springs named for the ROLE they play, not for how they feel.
 *
 * Before this existed there were no general-purpose springs at all — only four durations and one
 * bezier published twice under two names — so every surface that wanted physical motion invented
 * its own numbers. Naming by role is what stops that: a caller asks for `reflow`, not for
 * "stiffness 256, damping 32", and two lists re-laying-out therefore move identically.
 *
 * Two properties are deliberate and enforced by `motionSprings.test.ts`:
 *
 * 1. **Every role is exactly critically damped** (zeta = 1). `DESIGN.md` asks for non-bouncy motion
 *    on ordinary state changes; making that a property of the numbers rather than of anybody's
 *    restraint is what keeps it true a year from now.
 * 2. **The physics tables are module-private.** A config is only reachable through a resolver, and
 *    every resolver in the app — this one and the two tuned slide presets — is built by
 *    `createSpringConfigResolver`, which is the single place that decides what a spring does under
 *    the reduced-motion preference. A caller that could read a raw config could also decide that
 *    policy locally, and then there would be as many reduced-motion regimes as there are call
 *    sites.
 *
 * **Every role listed here has a live consumer, and that is a rule, not an accident.** The
 * vocabulary shipped with seven roles; four of them (`press`, `disclosure`, `surface`, `nudge`)
 * reached the end of the program with nothing animating them, and each surface that could have
 * claimed one declined for a stated reason: press feedback is an instant surface tint
 * (`usePressFeedback`, and a tint under a finger already there is not travel), the agent-activity
 * disclosure refuses to animate content mounting inside a height-cached transcript row without a
 * device capture, the popover's arrival is owned by its host rather than by the section inside it,
 * and an attention wobble is refused outright by the motion budget. A named role with no consumer
 * is not a reserved slot — it is a number nobody has ever seen, and the next caller has no way to
 * tell whether it was tuned or guessed. Re-add one in the SAME change that lands its animation.
 */

export const MOTION_SPRING_ROLES = [
    /** A status mark resolving in place — the agent-activity settle. Moves nothing around it. */
    'statusSettle',
    /** A row arriving in a list. */
    'rowEnter',
    /** A list re-laying-out after rows changed section. The slowest, because it moves the most. */
    'reflow',
] as const;

export type MotionSpringRole = (typeof MOTION_SPRING_ROLES)[number];

/**
 * What a role does when the user has asked for reduced motion.
 *
 * - `'instant'` — the animation is suppressed and the value lands on its target immediately. The
 *   state change still happens and is still visible; only the travel is removed.
 * - `'unchanged'` — the spring keeps running. Reserved for feedback that is not vestibular motion.
 */
export type MotionReducedMotionFallback = 'instant' | 'unchanged';

/**
 * What a role's motion DOES, for tests, documentation and derived timings.
 *
 * Deliberately carries no `stiffness`/`damping`/`mass`: those three would make a profile
 * structurally assignable to `WithSpringConfig`, so `withSpring(v, describeMotionSpring(role))`
 * would type-check — bypassing the resolver's reduced-motion stamp and handing Reanimated a
 * `dampingRatio` next to a stiffness, which is the duration/dampingRatio mixture the physics table
 * exists to avoid. Read the physics from `resolveMotionSpring`, which is the only way to get a
 * usable config.
 */
export type MotionSpringProfile = Readonly<{
    /** omega0 = sqrt(k / m), in rad/s. */
    angularFrequency: number;
    /** zeta = c / (2 * sqrt(k * m)). 1 is critically damped; below 1 overshoots. */
    dampingRatio: number;
    /**
     * Time for the response envelope to fall inside 1% of the initial displacement, in ms.
     *
     * This is the PERCEPTUAL settle — when the motion is over to a viewer. It is not the moment
     * Reanimated declares the animation finished: v4 terminates on a relative-energy threshold
     * (`energyThreshold`, default 6e-9), which for these configs lands roughly 1.8x later while
     * moving under a tenth of a pixel. Design against `settleMs`; do not expect a `withSpring`
     * completion callback at exactly this time.
     *
     * For the two UNDERDAMPED roles it is the envelope, not the last band crossing: numeric
     * integration of the step response puts `surface`'s final 1% crossing at ~318ms against a
     * 288ms envelope, and `nudge`'s at ~306ms against 297ms, because the oscillation keeps
     * re-entering the band after the envelope has entered it. Do not use `surface.settleMs` or
     * `nudge.settleMs` as the moment to unmount something still visibly moving.
     */
    settleMs: number;
    /** Peak overshoot as a fraction of the travel. 0 when critically damped or stiffer. */
    overshootRatio: number;
}>;

export type SpringPhysics = Readonly<{ stiffness: number; damping: number; mass: number }>;

const MOTION_SPRING_PHYSICS = {
    statusSettle: { stiffness: 900, damping: 60, mass: 1 },
    rowEnter: { stiffness: 625, damping: 50, mass: 1 },
    reflow: { stiffness: 256, damping: 32, mass: 1 },
} as const satisfies Record<MotionSpringRole, SpringPhysics>;

const MOTION_REDUCED_MOTION_FALLBACKS = {
    // The glyph swap still happens, without the scale-up. This is the documented reduced-motion
    // behaviour of the status settle: an immediate mark change with the elapsed clock still running.
    statusSettle: 'instant',
    rowEnter: 'instant',
    reflow: 'instant',
} as const satisfies Record<MotionSpringRole, MotionReducedMotionFallback>;

/**
 * Root of `(1 + x) * e^(-x) = 0.01`, the critically damped step response reaching 1% of its
 * initial displacement. Solved numerically once; `motionSprings.test.ts` checks the settle times
 * this produces against values derived independently of this file.
 */
const CRITICAL_SETTLE_X = 6.638352;

/** ln(100): the underdamped envelope `e^(-zeta*omega0*t)` reaching 1%. */
const UNDERDAMPED_SETTLE_X = Math.log(100);

export function describeMotionSpring(role: MotionSpringRole): MotionSpringProfile {
    const { stiffness, damping, mass } = MOTION_SPRING_PHYSICS[role];
    const angularFrequency = Math.sqrt(stiffness / mass);
    const dampingRatio = damping / (2 * Math.sqrt(stiffness * mass));

    if (dampingRatio >= 1) {
        return Object.freeze({
            angularFrequency,
            dampingRatio,
            settleMs: (CRITICAL_SETTLE_X / angularFrequency) * 1000,
            overshootRatio: 0,
        });
    }

    return Object.freeze({
        angularFrequency,
        dampingRatio,
        settleMs: (UNDERDAMPED_SETTLE_X / (dampingRatio * angularFrequency)) * 1000,
        overshootRatio: Math.exp((-Math.PI * dampingRatio) / Math.sqrt(1 - dampingRatio * dampingRatio)),
    });
}

export function resolveMotionReducedFallback(role: MotionSpringRole): MotionReducedMotionFallback {
    return MOTION_REDUCED_MOTION_FALLBACKS[role];
}

/**
 * The one decision about how a spring answers the reduced-motion preference.
 *
 * `ReduceMotion.Never` on an ordinary config is deliberate: it means "the library must not
 * second-guess this". The library default is `ReduceMotion.System`, which reads the DEVICE setting
 * directly — so a component whose `reducedMotion` prop overrides that preference everywhere else
 * would still get a spring disagreeing with it.
 */
function resolveReduceMotionPolicy(
    options: Readonly<{ fallback: MotionReducedMotionFallback; reducedMotion: boolean }>,
): ReduceMotion {
    if (!options.reducedMotion) return ReduceMotion.Never;
    return options.fallback === 'unchanged' ? ReduceMotion.Never : ReduceMotion.Always;
}

export type SpringConfigResolver<TName extends string> = (
    name: TName,
    options: Readonly<{ reducedMotion: boolean }>,
) => WithSpringConfig;

/**
 * Turns a table of physics plus a table of reduced-motion fallbacks into the only function that
 * hands those springs out.
 *
 * Every spring in the app is assembled here, including the two tuned slide presets
 * (`slideTransitionTokens.ts`) that are visual signatures rather than roles and so keep their own
 * names. Sharing the assembly is what keeps one answer to three questions that were previously
 * about to be answered twice: what the reduced-motion policy is, whether a config is frozen, and
 * whether repeated calls return the same object.
 *
 * Each reduced-motion variant is one object per (name, reducedMotion) pair for the process. Call
 * sites put these straight into dependency arrays, and a freshly allocated config per call would
 * re-run every one of those effects on every render.
 *
 * That table is built on FIRST USE rather than at module evaluation, and the difference is not an
 * optimisation. `resolveReduceMotionPolicy` reads a value out of `react-native-reanimated`, so
 * building at module scope made merely IMPORTING this file — or the `components/ui/motion` barrel
 * that re-exports it, or `slideTransitionTokens` which builds on it — reach into the animation
 * runtime. Under Vitest that is a mocked module: 60+ suites override the canonical testkit mock
 * with a hand-rolled subset, and the eager build failed 23 of them at collection with 285 errors,
 * none of them about motion. Nothing needs a spring config before something animates, so nothing
 * should need the runtime before then either. Identity is unchanged — each table is still built at
 * most once.
 */
export function createSpringConfigResolver<TName extends string>(
    physics: Readonly<Record<TName, SpringPhysics>>,
    fallbacks: Readonly<Record<TName, MotionReducedMotionFallback>>,
): SpringConfigResolver<TName> {
    const build = (reducedMotion: boolean): Readonly<Record<TName, WithSpringConfig>> => {
        const configs = {} as Record<TName, WithSpringConfig>;
        for (const name of Object.keys(physics) as TName[]) {
            configs[name] = Object.freeze({
                ...physics[name],
                reduceMotion: resolveReduceMotionPolicy({ fallback: fallbacks[name], reducedMotion }),
            }) satisfies WithSpringConfig;
        }
        return Object.freeze(configs);
    };

    let fullMotionConfigs: Readonly<Record<TName, WithSpringConfig>> | null = null;
    let reducedMotionConfigs: Readonly<Record<TName, WithSpringConfig>> | null = null;

    return (name, options) => {
        if (options.reducedMotion) {
            reducedMotionConfigs ??= build(true);
            return reducedMotionConfigs[name];
        }
        fullMotionConfigs ??= build(false);
        return fullMotionConfigs[name];
    };
}

export const resolveMotionSpring: SpringConfigResolver<MotionSpringRole> = createSpringConfigResolver(
    MOTION_SPRING_PHYSICS,
    MOTION_REDUCED_MOTION_FALLBACKS,
);
