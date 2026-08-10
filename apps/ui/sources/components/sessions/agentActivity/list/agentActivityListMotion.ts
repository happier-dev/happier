import { FadeIn, LinearTransition } from 'react-native-reanimated';

import {
    resolveMotionReducedFallback,
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

/** A row travelling between sections, and every row that has to make space for it. */
const REFLOW_LAYOUT = withRolePhysics(LinearTransition.springify(), 'reflow');

/** A row that has genuinely just arrived in the roster. */
const ROW_ENTERING = withRolePhysics(FadeIn.springify(), 'rowEnter');

/**
 * Whether the reduced-motion preference removes each animation.
 *
 * Read from the role table, never decided here, so this list cannot drift away from the rest of
 * the vocabulary: both roles map to `'instant'`, meaning the state change still happens and only
 * the travel is removed.
 */
const REFLOW_IS_INSTANT_WHEN_REDUCED = resolveMotionReducedFallback('reflow') === 'instant';
const ROW_ENTER_IS_INSTANT_WHEN_REDUCED = resolveMotionReducedFallback('rowEnter') === 'instant';

export type AgentActivityListMotion = Readonly<{
    /** Passed to every item in the list, so a reflow moves all of them together. */
    layout: SpringMotionBuilder | undefined;
    /** Passed only to items that were not in the previous render. */
    entering: SpringMotionBuilder | undefined;
}>;

const MOTION_FULL: AgentActivityListMotion = Object.freeze({
    layout: REFLOW_LAYOUT,
    entering: ROW_ENTERING,
});

const MOTION_NONE: AgentActivityListMotion = Object.freeze({
    layout: undefined,
    entering: undefined,
});

const MOTION_REDUCED: AgentActivityListMotion = Object.freeze({
    layout: REFLOW_IS_INSTANT_WHEN_REDUCED ? undefined : REFLOW_LAYOUT,
    entering: ROW_ENTER_IS_INSTANT_WHEN_REDUCED ? undefined : ROW_ENTERING,
});

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
    return params.reducedMotion ? MOTION_REDUCED : MOTION_FULL;
}
