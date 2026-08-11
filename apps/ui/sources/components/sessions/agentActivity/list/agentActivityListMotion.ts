import { FadeIn, LinearTransition } from 'react-native-reanimated';

import {
    resolveMotionPresentation,
    resolveMotionSpring,
    type MotionSpringRole,
} from '@/components/ui/motion';

/**
 * The two animations the agent roster runs, and the one rule that decides whether they run.
 *
 * This is the app's first and only layout animation, so it is deliberately contained: a row that
 * changes section travels to it on the shared `reflow` spring, and a row that genuinely arrives
 * fades in on `rowEnter`. Nothing else in the list animates — no stagger, no wash, no ping.
 *
 * **Ceiling, recorded at the owner (§N2).** Both animations assume the list renders every row.
 * `AgentActivityList` lays out a plain column and its hosts scroll it, which is what makes a
 * section change a MOVE rather than an unmount plus a mount. If a host ever virtualizes this list,
 * both must be switched off in the same change: `layout` would animate recycling, and `entering`
 * would replay every time a row scrolled back into view — the "re-entering row is not a new row"
 * rule would no longer hold, because the freshness gate can only see rows that are mounted.
 */

/**
 * A spring-driven layout/entering builder, named through the library's own return type rather
 * than by importing the builder class it happens to be today.
 */
type SpringMotionBuilder = ReturnType<typeof LinearTransition.springify>;

/**
 * Give an already-springified builder the physics of a role.
 *
 * `WithSpringConfig` types every physics field optional; `resolveMotionSpring` builds each config
 * by spreading a complete `SpringPhysics` for every role, so all three are always present.
 */
function withRolePhysics(builder: SpringMotionBuilder, role: MotionSpringRole): SpringMotionBuilder {
    const config = resolveMotionSpring(role, { reducedMotion: false });
    return builder
        .stiffness(config.stiffness!)
        .damping(config.damping!)
        .mass(config.mass!);
}

/**
 * The two builders, built on FIRST USE and then shared for the process.
 *
 * `LinearTransition.springify()` is a call into the animation runtime, so building these during
 * module evaluation would mean that merely IMPORTING this file reaches into that runtime — and
 * this file is reached from `AgentActivityList`, which sits inside the session shell. Under Vitest
 * the runtime is a mock, and a suite that narrows it then fails at collection with an error about
 * an animation it never rendered. Same reason `createSpringConfigResolver` and
 * `reanimatedMotionTokens` defer their own construction.
 *
 * One object each, forever: these go onto every item, so a fresh builder would defeat the rows'
 * memoization.
 */
let springBuilders: Readonly<{ reflow: SpringMotionBuilder; rowEnter: SpringMotionBuilder }> | null = null;

function resolveSpringBuilders(): Readonly<{ reflow: SpringMotionBuilder; rowEnter: SpringMotionBuilder }> {
    return (springBuilders ??= Object.freeze({
        /** A row travelling between sections, and every row that has to make space for it. */
        reflow: withRolePhysics(LinearTransition.springify(), 'reflow'),
        /** A row that has genuinely just arrived in the roster. */
        rowEnter: withRolePhysics(FadeIn.springify(), 'rowEnter'),
    }));
}

/**
 * Whether the reduced-motion preference removes each animation.
 *
 * Asked of `resolveMotionPresentation` — the one owner of "given the preference, what does this
 * animation do" — and never decided here. Reading the spring table directly instead would make
 * this a SECOND reader of that policy: it would answer for the spring rather than for the
 * animation, so a row the table later moved off a spring (or onto a substitute, as `spinner` is)
 * would keep animating here with nothing failing. `StatusTransition` carried the same shape and
 * lost it for the same reason.
 */
const SECTION_MIGRATION_IS_INSTANT_WHEN_REDUCED =
    resolveMotionPresentation('sectionMigration', true) === 'settleInstantly';
const ROW_ENTER_IS_INSTANT_WHEN_REDUCED =
    resolveMotionPresentation('rowEnter', true) === 'settleInstantly';

export type AgentActivityListMotion = Readonly<{
    /** Passed to every item in the list, so a reflow moves all of them together. */
    layout: SpringMotionBuilder | undefined;
    /** Passed only to items that were not in the previous render. */
    entering: SpringMotionBuilder | undefined;
}>;

const MOTION_NONE: AgentActivityListMotion = Object.freeze({
    layout: undefined,
    entering: undefined,
});

let motionFull: AgentActivityListMotion | null = null;
let motionReduced: AgentActivityListMotion | null = null;

function resolveMotionFull(): AgentActivityListMotion {
    const builders = resolveSpringBuilders();
    return (motionFull ??= Object.freeze({ layout: builders.reflow, entering: builders.rowEnter }));
}

function resolveMotionReduced(): AgentActivityListMotion {
    // Both animations settle instantly today, so this asks the runtime for nothing at all. The
    // per-field calls keep that true by construction if one of them ever stops being instant.
    return (motionReduced ??= Object.freeze({
        layout: SECTION_MIGRATION_IS_INSTANT_WHEN_REDUCED ? undefined : resolveSpringBuilders().reflow,
        entering: ROW_ENTER_IS_INSTANT_WHEN_REDUCED ? undefined : resolveSpringBuilders().rowEnter,
    }));
}

/**
 * Which animations this render may attach. Returns one of three shared objects, because these go
 * straight onto every item and a fresh object per render would defeat the rows' memoization.
 *
 * `animationEnabled: false` means nobody is looking — an inactive tab, an off-screen pane — and
 * animating there is work paid for and never seen.
 */
export function resolveAgentActivityListMotion(params: Readonly<{
    animationEnabled: boolean;
    reducedMotion: boolean;
}>): AgentActivityListMotion {
    if (!params.animationEnabled) return MOTION_NONE;
    return params.reducedMotion ? resolveMotionReduced() : resolveMotionFull();
}
