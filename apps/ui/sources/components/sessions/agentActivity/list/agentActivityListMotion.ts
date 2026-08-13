import * as React from 'react';
import { FadeIn, LinearTransition } from 'react-native-reanimated';

import {
    resolveMotionPresentation,
    resolveMotionSpring,
    type MotionSpringRole,
} from '@/components/ui/motion';

/**
 * The two animations the agent roster runs, and the rules that decide whether they run.
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

let motionFull: AgentActivityListMotion | null = null;
let motionArriving: AgentActivityListMotion | null = null;
let motionReduced: AgentActivityListMotion | null = null;

function resolveMotionFull(): AgentActivityListMotion {
    const builders = resolveSpringBuilders();
    return (motionFull ??= Object.freeze({ layout: builders.reflow, entering: builders.rowEnter }));
}

/**
 * What a list that is still arriving may animate: an entrance, and nothing that MOVES.
 *
 * `entering` is kept because it answers a different question — "is this row new" — and the list
 * already withholds it from the roster it opened with. It is opacity, so it cannot slide anything.
 */
function resolveMotionArriving(): AgentActivityListMotion {
    return (motionArriving ??= Object.freeze({
        layout: undefined,
        entering: resolveSpringBuilders().rowEnter,
    }));
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
 * How long a freshly mounted list refuses to animate layout at all.
 *
 * **This is a WEB defect with a platform-agnostic fix.** A layout transition on web interpolates
 * `getBoundingClientRect`s, so it cannot tell a row moving inside the list from the whole list
 * being moved by the surface around it — and a portal popover renders its content before it has
 * measured its anchor, then moves it there. The work-state popover therefore opened with every row
 * sliding out of the portal's top-left corner, every time. Native is unaffected (a layout
 * animation there sees the view's layout within its parent, which an ancestor move does not
 * change), and the gate applies on both because "content that was already there is not arriving"
 * is not a platform rule.
 *
 * **Why a window rather than "skip the first render".** On web the mount commit cannot animate
 * layout at all — reanimated starts a layout transition only from `componentDidUpdate`, against
 * the rect captured in `getSnapshotBeforeUpdate` — so the damaging delta always lands on an EARLY
 * UPDATE, when the surface finally positions itself. A one-commit gate would suppress the one
 * commit that was already inert. The window has to outlast the host's arrival: the popover
 * measures its anchor synchronously, its content a frame later, and retries an invalid
 * measurement for up to five frames.
 *
 * The ceiling this assumes: no reflow the list owns can come due inside it. The shortest is a
 * section migration, and that one waits `AGENT_ACTIVITY_MIGRATION_DWELL_MS` (900) first.
 */
export const AGENT_ACTIVITY_LIST_ARRIVAL_MS = 250;

/**
 * Which animations this render may attach. Returns one of three shared objects, because these go
 * straight onto every item and a fresh object per render would defeat the rows' memoization.
 *
 * Two things switch layout off, and they are asked in this order: the reader's preference, then
 * whether the list has been on screen long enough to believe its own geometry. Use
 * `useAgentActivityListMotion` — arrival is a fact about THIS list's life, so it is decided inside
 * the owner and cannot be passed in. An earlier `animationEnabled` prop learned the same lesson
 * the harder way: the case it was written for is a retained-but-inactive tab, and a frozen subtree
 * cannot receive the prop that would quiet it, because the commit that delivers it IS the commit
 * that unfreezes the tab. Removed in W30 rather than left as a switch only a test could throw.
 */
export function resolveAgentActivityListMotion(params: Readonly<{
    reducedMotion: boolean;
    /** False until this list has outlasted the arrival of the surface hosting it. */
    arrived: boolean;
}>): AgentActivityListMotion {
    if (params.reducedMotion) return resolveMotionReduced();
    return params.arrived ? resolveMotionFull() : resolveMotionArriving();
}

/**
 * The list's own answer to "may I move things yet".
 *
 * One timer per mounted list, armed once and never re-armed: a list that has settled stays
 * settled, so a migration that comes due later registers its animation a long time before the
 * layout it animates. Re-arming on later renders would put the gate back in front of a reflow the
 * list genuinely owns.
 */
export function useAgentActivityListMotion(params: Readonly<{
    reducedMotion: boolean;
}>): AgentActivityListMotion {
    const [arrived, setArrived] = React.useState(false);
    React.useEffect(() => {
        if (arrived) return;
        const timer = setTimeout(() => setArrived(true), AGENT_ACTIVITY_LIST_ARRIVAL_MS);
        return () => clearTimeout(timer);
    }, [arrived]);
    return resolveAgentActivityListMotion({ reducedMotion: params.reducedMotion, arrived });
}
